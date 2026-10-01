/* =========================================================
   GET /api/presupuesto-publico?id=123&token=xxxx
   Lee un presupuesto para la página pública que ve el cliente (sin tener
   que iniciar sesión en el CRM) — por eso pasa por el backend con la
   Admin SDK en vez de ir directo a Firestore: las reglas normales de
   Firestore exigen estar conectado, y aquí el cliente no lo está. El
   "token" (guardado en el propio presupuesto al crearlo) hace de llave:
   sin el id y el token exactos no se puede leer nada.
   ========================================================= */
const { iniciar, permitirCors } = require('./_firebase');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'GET') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db } = iniciar();
        const { id, token } = req.query;
        if (!id || !token) return res.status(400).json({ error: 'Faltan datos.' });

        const doc = await db.collection('presupuestos').doc(String(id)).get();
        if (!doc.exists || doc.data().token_publico !== token) {
            return res.status(404).json({ error: 'Presupuesto no encontrado.' });
        }
        const presupuesto = doc.data();

        const clienteDoc = await db.collection('clientes').doc(String(presupuesto.cliente_id)).get();
        const cliente = clienteDoc.exists ? clienteDoc.data() : null;

        res.status(200).json({
            ok: true,
            presupuesto: {
                id: presupuesto.id, empresa: presupuesto.empresa, lineas: presupuesto.lineas,
                total: presupuesto.total, estado: presupuesto.estado, fecha_creacion: presupuesto.fecha_creacion,
                lineas_aprobadas: presupuesto.lineas_aprobadas || null,
                ya_firmado: !!presupuesto.fecha_firma,
            },
            cliente: cliente ? { nombre_empresa: cliente.nombre_empresa } : null,
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno.' });
    }
};
