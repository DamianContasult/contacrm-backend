/* =========================================================
   POST /api/presupuesto-firmar
   Body: { id, token, lineasAprobadas: [bool...], firmanteNombre, firmaBase64 }
   El cliente, desde la página pública (sin sesión en el CRM), marca qué
   líneas acepta y firma con el dedo/ratón. Como no está autenticado, esto
   pasa por el backend con la Admin SDK — el "token" guardado en el propio
   presupuesto es lo único que protege la escritura.

   Si queda al menos una línea aprobada: se da de alta al cliente (si no
   lo estaba), se marca el paso "p5" del protocolo de alta, se arranca su
   cuota mensual con las líneas mensuales aprobadas, y se avisa a
   Facturación. Si no aprueba ninguna línea, el presupuesto queda como
   "rechazado" sin tocar nada del cliente.
   ========================================================= */
const { iniciar, permitirCors } = require('./_firebase');

async function siguienteId(db, coleccion) {
    const snap = await db.collection(coleccion).orderBy('id', 'desc').limit(1).get();
    if (snap.empty) return 1;
    return Number(snap.docs[0].data().id) + 1;
}

async function marcarPasoProtocolo(db, clienteId, pasoId, notas) {
    const ref = db.collection('clientes').doc(String(clienteId));
    const doc = await ref.get();
    if (!doc.exists) return;
    const estado = doc.data().protocolo_alta || { activo: true, tipo: null, pasos: {}, fecha_inicio: new Date().toISOString() };
    estado.pasos = estado.pasos || {};
    estado.pasos[pasoId] = { completado: true, fecha: new Date().toISOString(), usuario_id: null, notas };
    await ref.update({ protocolo_alta: estado });
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
        const algunaAprobada = totalAprobado > 0;

        await ref.update({
            estado: algunaAprobada ? 'aceptado' : 'rechazado',
            lineas_aprobadas: lineasAprobadas,
            firma_cliente_base64: firmaBase64, firmante_nombre: firmanteNombre,
            fecha_firma: new Date().toISOString(), fecha_respuesta: new Date().toISOString(),
        });

        if (algunaAprobada) {
            await db.collection('clientes').doc(String(presupuesto.cliente_id)).update({ estado: 'cliente' });
            await marcarPasoProtocolo(db, presupuesto.cliente_id, 'p5', 'Presupuesto firmado por el cliente.');
            const cuotaMensual = lineasConAprobacion.filter(l => l.aprobada && l.periodicidad === 'mensual').reduce((s, l) => s + l.importe, 0);
            if (cuotaMensual > 0) {
                const clienteRef = db.collection('clientes').doc(String(presupuesto.cliente_id));
                const clienteDoc = await clienteRef.get();
                const fichaActual = (clienteDoc.exists && clienteDoc.data().ficha) || {};
                await clienteRef.update({ ficha: { ...fichaActual, cuota_mensual: cuotaMensual } });
            }
        }

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
                titulo: algunaAprobada ? 'Presupuesto firmado por el cliente' : 'Presupuesto rechazado por el cliente',
                mensaje: `${firmanteNombre} ha ${algunaAprobada ? `firmado (${totalAprobado.toFixed(2)} €)` : 'rechazado'} el presupuesto #${id}.`,
                enlace: 'facturacion.html', leido: false, fecha: new Date().toISOString(),
            });
        }

        res.status(200).json({ ok: true, estado: algunaAprobada ? 'aceptado' : 'rechazado', totalAprobado });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno.' });
    }
};
