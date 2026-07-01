// middleware.js
// Corre en el Edge antes de servir /  y /api/config.
// Deja pasar solo si hay una cookie de sesión válida; si no, redirige a /login.html
// (o devuelve 401 si es un pedido a /api/).

export const config = {
  matcher: ['/', '/index.html', '/api/config'],
};

function getCookie(req, name) {
  const cookieHeader = req.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default function middleware(req) {
  const token = getCookie(req, 'hub_session');
  const expected = process.env.ADMIN_SESSION_TOKEN;

  if (token && expected && token === expected) {
    return; // sesión válida, dejar pasar
  }

  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'No autorizado' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  url.pathname = '/login.html';
  return Response.redirect(url);
}
