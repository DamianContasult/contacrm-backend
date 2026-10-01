/* =========================================================
   POST /api/set-password
   Body: { idToken, usuarioId, nuevaPassword }
   Cambia la contraseña de OTRO empleado. Solo un administrador puede
   llamar a esto — se comprueba aquí, en el servidor, no en el navegador.
   ========================================================= */
const { iniciar, exigirAdmin, permitirCors } = require('./_firebase');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db, authAdmin } = iniciar();
        const { idToken, usuarioId, nuevaPassword } = req.body || {};

        await exigirAdmin(db, authAdmin, idToken);

        if (!usuarioId) return res.status(400).json({ error: 'Falta el usuario al que cambiar la contraseña.' });
        if (!nuevaPassword || nuevaPassword.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });

        // El vínculo uid (Firebase Auth) -> usuario_id (ficha en Firestore) vive al revés en
        // "uid_index" (uid como clave), así que para ir del id numérico al uid hace falta
        // buscarlo — con la Admin SDK esto no pasa por las reglas de seguridad del cliente.
        const indice = await db.collection('uid_index').where('usuario_id', '==', Number(usuarioId)).limit(1).get();
        if (indice.empty) return res.status(404).json({ error: 'Ese empleado todavía no tiene una cuenta de acceso creada.' });
        const uidObjetivo = indice.docs[0].id;

        await authAdmin.updateUser(uidObjetivo, { password: nuevaPassword });
        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
    }
};
