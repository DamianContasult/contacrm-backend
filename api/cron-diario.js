/* =========================================================
   GET /api/cron-diario
   Vercel Cron lo llama una vez al día (ver vercel.json en la raíz del
   repo). Revisa facturas emitidas sin cobrar y facturas recibidas sin
   contabilizar, y avisa al departamento de Facturación (tarea +
   notificación + un correo resumen) cuando tocan sus plazos.

   Seguridad: si existe la variable de entorno CRON_SECRET, Vercel añade
   automáticamente la cabecera "Authorization: Bearer <CRON_SECRET>" en
   sus propias llamadas a este endpoint — así se comprueba que la
   petición viene de verdad de Vercel Cron y no de cualquiera que
   adivine la URL.
   ========================================================= */
const { iniciar } = require('./_firebase');

const DIAS_AVISO_COBROS = [5, 8, 20];
const DIAS_AVISO_FACTURAS_RECIBIDAS = 7;

function diasDesde(fechaIso) {
    const ms = Date.now() - new Date(fechaIso + 'T00:00:00Z').getTime();
    return Math.floor(ms / 86400000);
}

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

async function enviarCorreoResumen(destinatarios, lineas) {
    if (destinatarios.length === 0 || lineas.length === 0) return;
    const token = await tokenGraphAppOnly();
    const remitente = process.env.GRAPH_REMITENTE || 'info@contasult.com';
    const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${remitente}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject: `ContaCRM · Avisos de Facturación (${lineas.length})`,
                body: { contentType: 'HTML', content: `<p>Avisos automáticos de hoy:</p><ul>${lineas.map(l => `<li>${l}</li>`).join('')}</ul>` },
                toRecipients: destinatarios.map(email => ({ emailAddress: { address: email } })),
            },
            saveToSentItems: true,
        }),
    });
    if (!resp.ok) throw new Error('Graph sendMail: ' + (await resp.text()));
}

module.exports = async (req, res) => {
    if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: 'No autorizado.' });
    }

    try {
        const { db } = iniciar();
        // El usuario solo guarda "departamento_id" (número) en Firestore; el nombre "Facturación"
        // solo existe como texto en la colección "departamentos" — hay que resolverlo primero.
        const departamentosSnap = await db.collection('departamentos').where('nombre', '==', 'Facturación').limit(1).get();
        const usuariosFacturacion = departamentosSnap.empty ? [] : (
            await db.collection('usuarios').where('departamento_id', '==', Number(departamentosSnap.docs[0].id)).get()
        ).docs.map(d => ({ id: Number(d.id), ...d.data() }));
        const emailsFacturacion = usuariosFacturacion.map(u => u.email).filter(Boolean);
        const lineasCorreo = [];

        async function avisarFacturacion(titulo, mensaje, enlace) {
            for (const u of usuariosFacturacion) {
                const id = await siguienteId(db, 'notificaciones');
                await db.collection('notificaciones').doc(String(id)).set({
                    id, usuario_id: u.id, tipo: 'facturacion', titulo, mensaje,
                    enlace: enlace || 'facturacion.html', leido: false, fecha: new Date().toISOString(),
                });
            }
            lineasCorreo.push(`${titulo} — ${mensaje}`);
        }

        async function crearTarea(titulo, descripcion, diasPlazo = 3) {
            const id = await siguienteId(db, 'tareas');
            const limite = new Date();
            limite.setUTCDate(limite.getUTCDate() + diasPlazo);
            await db.collection('tareas').doc(String(id)).set({
                id, titulo, descripcion, etapa_id: 1, cliente_id: null, expediente_id: null,
                asignado_a: null, colaboradores: [], creado_por: null, prioridad: 'alta',
                fecha_limite: limite.toISOString().slice(0, 10), fecha_creacion: new Date().toISOString(),
                finalizada: false, fecha_finalizacion: null, finalizado_por: null,
            });
        }

        // ---- Control de cobros: facturas emitidas sin cobrar ----
        const facturasEmitidas = (await db.collection('facturas_emitidas').where('cobrada', '==', false).get())
            .docs.map(d => ({ id: Number(d.id), ...d.data() }));
        for (const f of facturasEmitidas) {
            const dias = diasDesde(f.fecha_emision);
            const avisos = f.avisos_enviados || [];
            let cambiado = false;
            for (const umbral of DIAS_AVISO_COBROS) {
                if (dias >= umbral && !avisos.includes(umbral)) {
                    const detalle = `${f.cliente_nombre || 'Cliente'} — ${f.concepto || ''} (${f.importe != null ? f.importe + ' €' : 'sin importe'})`;
                    if (umbral === 5) await crearTarea(`Reclamar cobro: ${f.cliente_nombre || f.concepto || f.id}`, detalle);
                    await avisarFacturacion(`Factura sin cobrar (${f.empresa}, ${dias} días)`, detalle, 'facturacion.html');
                    avisos.push(umbral);
                    cambiado = true;
                }
            }
            if (cambiado) await db.collection('facturas_emitidas').doc(String(f.id)).update({ avisos_enviados: avisos });
        }

        // ---- Facturas recibidas sin contabilizar ----
        const facturasRecibidas = (await db.collection('facturas_recibidas').where('contabilizada', '==', false).get())
            .docs.map(d => ({ id: Number(d.id), ...d.data() }));
        for (const f of facturasRecibidas) {
            const dias = diasDesde(f.fecha_recepcion);
            if (dias >= DIAS_AVISO_FACTURAS_RECIBIDAS && !f.aviso_enviado) {
                const detalle = `${f.proveedor || 'Proveedor'} — ${f.concepto || ''} (${f.importe != null ? f.importe + ' €' : 'sin importe'})`;
                await crearTarea(`Contabilizar factura: ${f.proveedor || f.id}`, detalle);
                await avisarFacturacion(`Factura recibida sin contabilizar (${f.empresa}, ${dias} días)`, detalle, 'facturacion.html');
                await db.collection('facturas_recibidas').doc(String(f.id)).update({ aviso_enviado: true });
            }
        }

        await enviarCorreoResumen(emailsFacturacion, lineasCorreo);

        res.status(200).json({ ok: true, avisos: lineasCorreo.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Error interno.' });
    }
};
