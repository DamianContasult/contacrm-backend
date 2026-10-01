/* =========================================================
   POST /api/send-notification
   Body: { idToken, destinatarios: [usuarioId...], titulo, cuerpo, url }
   Empuja una notificación de escritorio (Firebase Cloud Messaging) a los
   dispositivos registrados de cada destinatario. Cualquier empleado con
   sesión iniciada puede llamar a esto (no hace falta ser administrador):
   es lo que usa el chat para avisar de un mensaje nuevo.
   ========================================================= */
const { iniciar, exigirSesion, permitirCors } = require('./_firebase');
const { getMessaging } = require('firebase-admin/messaging');

module.exports = async (req, res) => {
    if (permitirCors(req, res)) return;
    if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });

    try {
        const { db, authAdmin } = iniciar();
        const { idToken, destinatarios, titulo, cuerpo, url } = req.body || {};

        await exigirSesion(authAdmin, idToken);

        if (!Array.isArray(destinatarios) || destinatarios.length === 0) {
            return res.status(400).json({ error: 'Falta a quién avisar.' });
        }

        const messaging = getMessaging();
        for (const usuarioId of destinatarios) {
            const ficha = await db.collection('usuarios').doc(String(usuarioId)).get();
            const tokens = (ficha.exists && ficha.data().fcm_tokens) || [];
            if (tokens.length === 0) continue;

            const respuesta = await messaging.sendEachForMulticast({
                tokens,
                notification: { title: titulo || 'ContaCRM', body: cuerpo || 'Tienes un mensaje nuevo.' },
                webpush: { fcmOptions: { link: url || '/' } },
            });

            // Un token puede quedar obsoleto (el usuario desinstaló el navegador, borró datos...);
            // si Firebase lo rechaza como inválido, se limpia aquí para no seguir intentándolo.
            const codigosCaducos = ['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'];
            const tokensInvalidos = respuesta.responses
                .map((r, i) => (!r.success && codigosCaducos.includes(r.error && r.error.code)) ? tokens[i] : null)
                .filter(Boolean);
            if (tokensInvalidos.length > 0) {
                await db.collection('usuarios').doc(String(usuarioId)).update({
                    fcm_tokens: tokens.filter(t => !tokensInvalidos.includes(t)),
                });
            }
        }

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(err.status || 500).json({ error: err.message || 'Error interno.' });
    }
};
