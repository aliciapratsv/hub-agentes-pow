// api/login.js
// POST { password } → si coincide con ADMIN_PASSWORD, setea cookie de sesión

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { password } = req.body || {};

  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  const token = process.env.ADMIN_SESSION_TOKEN;
  res.setHeader(
    'Set-Cookie',
    `hub_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
  );

  return res.status(200).json({ ok: true });
}
