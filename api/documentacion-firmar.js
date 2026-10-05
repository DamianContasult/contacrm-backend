/* =========================================================
   POST /api/documentacion-firmar
   Body: { id, token, respuesta, firmanteNombre, firmaBase64, pdfBase64 }
   El cliente, desde la página pública, rellena los documentos de alta y los
   firma. Como no está autenticado, pasa por aquí con la Admin SDK — el
   "token" del propio envío es lo único que protege la escritura.

   Aquí solo se guarda la respuesta (datos, firma y PDF justificante) y se
   avisa a quien lo envió, por notificación y por correo con el PDF adjunto.
   ========================================================= */
const { iniciar, permitirCors } = require('./_firebase');

const LIMITE_PDF_BASE64 = 900000;

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

async function enviarCorreoJustificante({ destinatarios, cc, asunto, cuerpoHtml, pdfBase64, nombreFichero }) {
    if (destinatarios.length === 0) return;
    const token = await tokenGraphAppOnly();
    const remitente = process.env.GRAPH_REMITENTE || 'info@contasult.com';
    const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${remitente}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject: asunto,
                body: { contentType: 'HTML', content: cuerpoHtml },
                toRecipients: destinatarios.map(email => ({ emailAddress: { address: email } })),
                ccRecipients: (cc || []).map(email => ({ emailAddress: { address: email } })),
                attachments: [{
                    '@odata.type': '#microsoft.graph.fileAttachment',
                    name: nombreFichero, contentType: 'application/pdf', contentBytes: pdfBase64,
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
        const { id, token, respuesta, firmanteNombre, firmaBase64, pdfBase64 } = req.body || {};
        if (!id || !token || !respuesta || !firmanteNombre || !firmaBase64 || !pdfBase64) {
            return res.status(400).json({ error: 'Faltan datos.' });
        }
        if (pdfBase64.length > LIMITE_PDF_BASE64) {
            return res.status(413).json({ error: 'El justificante es demasiado grande.' });
        }

        const ref = db.collection('envios_documentacion').doc(String(id));
        const doc = await ref.get();
        if (!doc.exists || doc.data().token_publico !== token) {
            return res.status(404).json({ error: 'Envío no encontrado.' });
        }
        const envio = doc.data();
        if (envio.fecha_respuesta) return res.status(409).json({ error: 'Esta documentación ya ha sido enviada.' });

        const fechaRespuesta = new Date().toISOString();
        await ref.update({
            estado: 'respondido', fecha_respuesta: fechaRespuesta,
            respuesta: {
                datos: respuesta, firmante_nombre: firmanteNombre, firma_base64: firmaBase64, pdf_base64: pdfBase64,
                evidencia: {
                    fecha: fechaRespuesta,
                    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null,
                    user_agent: req.headers['user-agent'] || null,
                },
            },
        });

        if (envio.creado_por) {
            const notifId = await siguienteId(db, 'notificaciones');
            await db.collection('notificaciones').doc(String(notifId)).set({
                id: notifId, usuario_id: Number(envio.creado_por), tipo: 'documentacion',
                titulo: 'Documentación del cliente recibida',
                mensaje: `${firmanteNombre} ha enviado la documentación de alta. Revísala para confirmarla.`,
                enlace: `facturacion.html?documentacion=${id}`, leido: false, fecha: fechaRespuesta,
            });
        }

        try {
            const creadorDoc = envio.creado_por ? await db.collection('usuarios').doc(String(envio.creado_por)).get() : null;
            const destinatarios = creadorDoc && creadorDoc.exists && creadorDoc.data().email ? [creadorDoc.data().email] : [];
            await enviarCorreoJustificante({
                destinatarios,
                cc: [],
                asunto: `Documentación de alta firmada por ${firmanteNombre} — pendiente de revisar`,
                cuerpoHtml: `
                    <p>${firmanteNombre} ha enviado la documentación de alta el ${new Date(fechaRespuesta).toLocaleString('es-ES')}.</p>
                    <p>Te adjuntamos el justificante en PDF. Todavía está <b>pendiente de revisión</b>: confírmala desde ContaCRM (Facturación → Documentación de clientes).</p>
                `,
                pdfBase64,
                nombreFichero: `documentacion-${id}.pdf`,
            });
        } catch (err) {
            console.error('documentacion-firmar: no se pudo enviar el correo:', err.message);
        }

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno.' });
    }
};
