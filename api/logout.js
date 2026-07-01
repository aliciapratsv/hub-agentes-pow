// api/logout.js
// POST → borra la cookie de sesión

export default async function handler(req, res) {
  res.setHeader(
    'Set-Cookie',
    'hub_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  );
  return res.status(200).json({ ok: true });
}
