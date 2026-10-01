/* =========================================================
   POST /api/reset-password-link
   Body: { email }
   Genera un enlace de restablecimiento de contraseña (Firebase) y lo envía
   por correo vía Microsoft Graph desde info@contasult.com, en vez de que
   lo mande el propio Firebase — así llega desde una cuenta reconocible de
   la empresa. No exige sesión: lo llama la página de login antes de
   identificarse.

   Requiere en Azure Portal (la misma App registration que usa MSAL para
   Teams) un permiso de APLICACIÓN "Mail.Send" con consentimiento de
   administrador concedido, y un client secret propio (distinto del flujo
   de MSAL, que es de usuario). Variables de entorno en Vercel:
   GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_REMITENTE
   (opcional, por defecto info@contasult.com).

   Por seguridad, nunca revela si el email existe o no: siempre responde
   ok, tanto si el envío ha ido bien como si el email no correspondía a
   ningún usuario o ha fallado el envío (el detalle queda en los logs de
   Vercel, no en la respuesta).
   ========================================================= */
const { iniciar, permitirCors } = require('./_firebase');

async function tokenGraphAppOnly() {
    const tenantId = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const clientSecret = process.env.GRAPH_CLIENT_SECRET;
    const resp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            scope: 'https://graph.microsoft.com/.default',
            grant_type: 'client_credentials',
        }),
    });
    const datos = await resp.json();
    if (!resp.ok) throw new Error(datos.error_description || 'No se pudo autenticar con Microsoft Graph.');
    return datos.access_token;
}

async function enviarCorreoRestablecimiento(email, nombre, enlace) {
    const token = await tokenGraphAppOnly();
    const remitente = process.env.GRAPH_REMITENTE || 'info@contasult.com';
    const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${remitente}/sendMail`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: {
                subject: 'Restablece tu contraseña de ContaCRM',
                body: {
                    contentType: 'HTML',
                    content: `<p>Hola${nombre ? ' ' + nombre : ''},</p>
                        <p>Hemos recibido una solicitud para restablecer tu contraseña de ContaCRM.</p>
                        <p><a href="${enlace}">Elegir una contraseña nueva</a></p>
                        <p>Si tú no has pedido esto, puedes ignorar este correo: tu contraseña actual seguirá funcionando.</p>
                        <p>— ContaCRM · Contasult</p>`,
                },
                toRecipients: [{ emailAddress: { address: email } }],
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
        const { db, authAdmin } = iniciar();
        const { email } = req.body || {};
        if (!email) return res.status(400).json({ error: 'Falta el email.' });

        try {
            const usuarioAuth = await authAdmin.getUserByEmail(email);
            const enlace = await authAdmin.generatePasswordResetLink(email);
            let nombre = '';
            const indice = await db.collection('uid_index').doc(usuarioAuth.uid).get();
            if (indice.exists) {
                const ficha = await db.collection('usuarios').doc(String(indice.data().usuario_id)).get();
                if (ficha.exists) nombre = ficha.data().nombre || '';
            }
            await enviarCorreoRestablecimiento(email, nombre, enlace);
        } catch (err) {
            // Aquí caen tanto "ese email no existe" como un fallo real de envío — a propósito
            // no se distinguen de cara a quien llama, solo en los logs del servidor.
            console.error('reset-password-link:', err.message);
        }

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno.' });
    }
};
