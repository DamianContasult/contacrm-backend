/* =========================================================
   POST /api/delete-user
   Body: { idToken, usuarioId }
   Elimina la cuenta de acceso (Firebase Auth) de OTRO empleado y su vínculo
   en uid_index, antes de que el CRM borre su ficha de Firestore — así no
   queda una cuenta huérfana que ya no corresponde a ningún perfil. Si ese
   empleado nunca llegó a tener cuenta de acceso, no hace nada (no es un
   error). Solo un administrador puede llamar a esto, y nunca sobre sí mismo.
   ========================================================= */
const { iniciar, exigirAdmin, permitirCors } = require('./_firebase');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db, authAdmin } = iniciar();
        const { idToken, usuarioId } = req.body || {};

        const { usuarioId: propioId } = await exigirAdmin(db, authAdmin, idToken);

        if (!usuarioId) return res.status(400).json({ error: 'Falta el empleado a eliminar.' });
        if (Number(usuarioId) === Number(propioId)) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta.' });

        const indice = await db.collection('uid_index').where('usuario_id', '==', Number(usuarioId)).limit(1).get();
        if (!indice.empty) {
            const uid = indice.docs[0].id;
            await authAdmin.deleteUser(uid).catch(err => {
                if (err.code !== 'auth/user-not-found') throw err;
            });
            await db.collection('uid_index').doc(uid).delete();
        }

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
    }
};
