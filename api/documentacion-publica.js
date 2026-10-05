/* =========================================================
   GET /api/documentacion-publica?id=123&token=xxxx
   Lee un envío de documentación de alta para la página pública que ve el
   cliente (sin sesión en el CRM). El "token" del propio envío hace de llave,
   igual que en presupuesto-publico.js.
   ========================================================= */
const { iniciar, permitirCors } = require('./_firebase');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db } = iniciar();
        const { id, token } = req.query;
        if (!id || !token) return res.status(400).json({ error: 'Faltan datos.' });

        const doc = await db.collection('envios_documentacion').doc(String(id)).get();
        if (!doc.exists || doc.data().token_publico !== token) {
            return res.status(404).json({ error: 'Envío no encontrado.' });
        }
        const envio = doc.data();

        const presupuestoDoc = await db.collection('presupuestos').doc(String(envio.presupuesto_id)).get();
        const presupuesto = presupuestoDoc.exists ? presupuestoDoc.data() : null;
        const lineas = presupuesto
            ? presupuesto.lineas.filter((_, i) => !presupuesto.lineas_aprobadas || presupuesto.lineas_aprobadas[i])
            : [];
        const total = lineas.reduce((s, l) => s + Number(l.importe || 0), 0);

        const clienteDoc = await db.collection('clientes').doc(String(envio.cliente_id)).get();
        const c = clienteDoc.exists ? clienteDoc.data() : {};
        const ficha = c.ficha || {};

        res.status(200).json({
            ok: true,
            envio: {
                id: envio.id, empresa: envio.empresa, documentos: envio.documentos,
                respondido: !!envio.fecha_respuesta,
            },
            cliente: {
                nombre: c.nombre_empresa || '',
                cif: ficha.cif_nif || c.nif || '',
                domicilio: ficha.direccion_fiscal || [c.direccion, c.ciudad].filter(Boolean).join(', '),
                tipo_cliente: ficha.tipo_cliente || '',
            },
            lineas: lineas.map(l => ({ servicio: l.servicio, importe: l.importe, periodicidad: l.periodicidad })),
            total,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno.' });
    }
};
