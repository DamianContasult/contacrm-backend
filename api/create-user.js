/* =========================================================
   POST /api/create-user
   Body: { idToken, usuarioId, email, password }
   Crea la cuenta de acceso de verdad (Firebase Auth) para un empleado que
   se acaba de dar de alta en Firestore desde "Equipo", y el vínculo
   uid_index -> usuario_id. Antes esto había que hacerlo a mano en la
   consola de Firebase; ahora lo hace este endpoint, que es el único sitio
   con permiso para crear cuentas (la Admin SDK no puede llamarse desde
   el navegador). Solo un administrador puede llamarlo.
   ========================================================= */
const { iniciar, exigirAdmin, permitirCors } = require('./_firebase');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db, authAdmin } = iniciar();
        const { idToken, usuarioId, email, password } = req.body || {};

        await exigirAdmin(db, authAdmin, idToken);

        if (!usuarioId || !email || !password) return res.status(400).json({ error: 'Faltan datos para crear la cuenta de acceso.' });
        if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

        const usuarioAuth = await authAdmin.createUser({ email, password });
        await db.collection('uid_index').doc(usuarioAuth.uid).set({ usuario_id: Number(usuarioId) });

        res.status(200).json({ ok: true, uid: usuarioAuth.uid });
    } catch (err) {
        console.error(err);
        if (err.code === 'auth/email-already-exists') return res.status(409).json({ error: 'Ya existe una cuenta de acceso con ese email.' });
        if (err.code === 'auth/invalid-email') return res.status(400).json({ error: 'El email no es válido.' });
        res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
    }
};
