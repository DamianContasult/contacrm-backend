/* =========================================================
   Inicializa la Admin SDK de Firebase una sola vez por instancia de la
   función. La clave de la cuenta de servicio nunca vive en el código ni en
   el repositorio: se lee de una variable de entorno privada configurada en
   Vercel (FIREBASE_SERVICE_ACCOUNT, el JSON completo de la clave como texto).
   ========================================================= */
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

function iniciar() {
    if (!getApps().length) {
        const credenciales = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        initializeApp({ credential: cert(credenciales) });
    }
    return { db: getFirestore(), authAdmin: getAuth() };
}

// Comprueba que quien llama de verdad ha iniciado sesión y de verdad es
// administrador — nunca nos fiamos de lo que diga el propio navegador sobre
// sí mismo, solo del token de Firebase (verificado aquí) y de lo que diga
// la base de datos sobre esa persona.
async function exigirAdmin(db, authAdmin, idToken) {
    if (!idToken) { const e = new Error('Falta el token de sesión.'); e.status = 401; throw e; }
    const decodificado = await authAdmin.verifyIdToken(idToken);
    const indice = await db.collection('uid_index').doc(decodificado.uid).get();
    if (!indice.exists) { const e = new Error('Esta cuenta no está vinculada a ningún perfil de ContaCRM.'); e.status = 403; throw e; }
    const perfil = await db.collection('usuarios').doc(String(indice.data().usuario_id)).get();
    if (!perfil.exists || !perfil.data().es_admin) { const e = new Error('Solo un administrador puede hacer esto.'); e.status = 403; throw e; }
    return { uid: decodificado.uid, usuarioId: indice.data().usuario_id };
}

// Como exigirAdmin, pero solo comprueba que quien llama ha iniciado sesión de verdad —
// para operaciones que cualquier empleado puede hacer (p.ej. avisar a un compañero de
// un mensaje nuevo), no solo un administrador.
async function exigirSesion(authAdmin, idToken) {
    if (!idToken) { const e = new Error('Falta el token de sesión.'); e.status = 401; throw e; }
    return authAdmin.verifyIdToken(idToken);
}

// Permite las peticiones del propio CRM desde cualquier origen donde esté
// alojado (localhost mientras se prueba, el dominio final después).
function permitirCors(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
    return false;
}

module.exports = { iniciar, exigirAdmin, exigirSesion, permitirCors };
