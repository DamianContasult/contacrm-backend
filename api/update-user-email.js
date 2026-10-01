/* =========================================================
   POST /api/update-user-email
   Body: { idToken, usuarioId, nuevoEmail }
   Cambia el email de la cuenta de acceso (Firebase Auth) de OTRO empleado,
   para que siga coincidiendo con el email de su ficha en Firestore. Solo
   un administrador puede llamar a esto.
   ========================================================= */
const { iniciar, exigirAdmin, permitirCors } = require('./_firebase');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db, authAdmin } = iniciar();
        const { idToken, usuarioId, nuevoEmail } = req.body || {};

        await exigirAdmin(db, authAdmin, idToken);

        if (!usuarioId || !nuevoEmail) return res.status(400).json({ error: 'Faltan datos para cambiar el email.' });

        const indice = await db.collection('uid_index').where('usuario_id', '==', Number(usuarioId)).limit(1).get();
        if (indice.empty) return res.status(404).json({ error: 'Ese empleado todavía no tiene una cuenta de acceso creada.' });
        const uid = indice.docs[0].id;

        await authAdmin.updateUser(uid, { email: nuevoEmail });
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        if (err.code === 'auth/email-already-exists') return res.status(409).json({ error: 'Ya existe una cuenta de acceso con ese email.' });
        if (err.code === 'auth/invalid-email') return res.status(400).json({ error: 'El email no es válido.' });
        res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
    }
};
