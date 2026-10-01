/* =========================================================
   POST /api/presupuesto-firmar
   Body: { id, token, lineasAprobadas: [bool...], firmanteNombre, firmaBase64 }
   El cliente, desde la página pública (sin sesión en el CRM), marca qué
   líneas acepta y firma con el dedo/ratón. Como no está autenticado, esto
   pasa por el backend con la Admin SDK — el "token" guardado en el propio
   presupuesto es lo único que protege la escritura.

   Importante: firmar NO da de alta al cliente ni arranca nada todavía.
   El presupuesto queda en estado "firmado" (pendiente de revisión) — solo
   cuando alguien de Facturación lo revisa y lo confirma desde el CRM
   (Api.presupuestos.confirmarRevision) pasa a "aceptado" de verdad. Aquí
   solo se guarda la respuesta del cliente y se avisa, por notificación y
   por correo (con la firma adjunta), a quien lo creó y a Facturación.
   ========================================================= */
const { iniciar, permitirCors } = require('./_firebase');

async function siguienteId(db, coleccion) {
    const snap = await db.collection(coleccion).orderBy('id', 'desc').limit(1).get();
    if (snap.empty) return 1;
    return Number(snap.docs[0].data().id) + 1;
}

async function tokenGraphAppOnly() {
    const resp = await fetch(`https://login.microsoftonline.com/${process.env.GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.GRAPH_CLIENT_ID,
            client_secret: process.env.GRAPH_CLIENT_SECRET,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
        }),
    });
    const datos = await resp.json();
    if (!resp.ok) throw new Error(datos.error_description || 'No se pudo autenticar con Microsoft Graph.');
    return datos.access_token;
}

async function enviarCorreoConfirmacion({ destinatarios, cc, asunto, lineasHtml, totalAprobado, firmanteNombre, fechaFirma, firmaBase64 }) {
    if (destinatarios.length === 0) return;
    const token = await tokenGraphAppOnly();
    const remitente = process.env.GRAPH_REMITENTE || 'info@contasult.com';
    const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${remitente}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject: asunto,
                body: {
                    contentType: 'HTML',
                    content: `
                        <p>${firmanteNombre} ha respondido al presupuesto el ${new Date(fechaFirma).toLocaleString('es-ES')}.</p>
                        <p><b>Servicios marcados por el cliente:</b></p>
                        <ul>${lineasHtml}</ul>
                        <p><b>Total marcado: ${totalAprobado.toFixed(2)} €</b></p>
                        <p>Firma del cliente:</p>
                        <img src="cid:firma_cliente" style="max-width:320px; border:1px solid #ccc;">
                        <p style="margin-top:20px;">Esto todavía <b>no es definitivo</b>: revísalo y confírmalo desde ContaCRM (Facturación → Presupuestos) para que quede aceptado.</p>
                    `,
                },
                toRecipients: destinatarios.map(email => ({ emailAddress: { address: email } })),
                ccRecipients: (cc || []).map(email => ({ emailAddress: { address: email } })),
                attachments: [{
                    '@odata.type': '#microsoft.graph.fileAttachment',
                    name: 'firma.png', contentType: 'image/png', contentBytes: firmaBase64,
                    isInline: true, contentId: 'firma_cliente',
                }],
            },
            saveToSentItems: true,
        }),
    });
    if (!resp.ok) throw new Error('Graph sendMail: ' + (await resp.text()));
}

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db } = iniciar();
        const { id, token, lineasAprobadas, firmanteNombre, firmaBase64 } = req.body || {};
        if (!id || !token || !Array.isArray(lineasAprobadas) || !firmanteNombre || !firmaBase64) {
            return res.status(400).json({ error: 'Faltan datos.' });
        }

        const ref = db.collection('presupuestos').doc(String(id));
        const doc = await ref.get();
        if (!doc.exists || doc.data().token_publico !== token) {
            return res.status(404).json({ error: 'Presupuesto no encontrado.' });
        }
        const presupuesto = doc.data();
        if (presupuesto.fecha_firma) return res.status(409).json({ error: 'Este presupuesto ya ha sido firmado.' });

        const lineasConAprobacion = presupuesto.lineas.map((l, i) => ({ ...l, aprobada: !!lineasAprobadas[i] }));
        const totalAprobado = lineasConAprobacion.filter(l => l.aprobada).reduce((s, l) => s + l.importe, 0);
        const fechaFirma = new Date().toISOString();

        // Firmar nunca es definitivo por sí solo: siempre queda "firmado", a la espera de que
        // Facturación lo revise y lo confirme (ver confirmarRevision en el frontend).
        await ref.update({
            estado: 'firmado', lineas_aprobadas: lineasAprobadas,
            firma_cliente_base64: firmaBase64, firmante_nombre: firmanteNombre,
            fecha_firma: fechaFirma, fecha_respuesta: fechaFirma,
        });

        // El usuario solo guarda "departamento_id" (número) en Firestore; el nombre "Facturación"
        // solo existe como texto en la colección "departamentos" — hay que resolverlo primero.
        const departamentosSnap = await db.collection('departamentos').where('nombre', '==', 'Facturación').limit(1).get();
        const usuariosFacturacion = departamentosSnap.empty ? [] : (
            await db.collection('usuarios').where('departamento_id', '==', Number(departamentosSnap.docs[0].id)).get()
        ).docs.map(d => ({ id: Number(d.id), ...d.data() }));

        for (const u of usuariosFacturacion) {
            const notifId = await siguienteId(db, 'notificaciones');
            await db.collection('notificaciones').doc(String(notifId)).set({
                id: notifId, usuario_id: u.id, tipo: 'facturacion',
                titulo: 'Presupuesto firmado, pendiente de revisar',
                mensaje: `${firmanteNombre} ha marcado ${totalAprobado.toFixed(2)} € en el presupuesto #${id}. Revísalo para confirmarlo.`,
                enlace: 'facturacion.html', leido: false, fecha: fechaFirma,
            });
        }

        try {
            const creadorDoc = presupuesto.creado_por ? await db.collection('usuarios').doc(String(presupuesto.creado_por)).get() : null;
            const destinatarios = [];
            if (creadorDoc && creadorDoc.exists && creadorDoc.data().email) destinatarios.push(creadorDoc.data().email);
            const cc = usuariosFacturacion.map(u => u.email).filter(e => e && !destinatarios.includes(e));
            const lineasHtml = lineasConAprobacion
                .map(l => `<li>${l.aprobada ? '✅' : '❌'} ${l.servicio} — ${l.importe.toFixed(2)} €</li>`)
                .join('');
            await enviarCorreoConfirmacion({
                destinatarios, cc, asunto: `Presupuesto #${id} firmado por ${firmanteNombre} — pendiente de revisar`,
                lineasHtml, totalAprobado, firmanteNombre, fechaFirma, firmaBase64,
            });
        } catch (err) {
            console.error('presupuesto-firmar: no se pudo enviar el correo de confirmación:', err.message);
        }

        res.status(200).json({ ok: true, estado: 'firmado', totalAprobado });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno.' });
    }
};
