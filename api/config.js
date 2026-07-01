// api/config.js
// GET  /api/config                    → lista todos los agentes con su config actual
// GET  /api/config?agent=taskpatrol   → config de un agente puntual
// GET  /api/config?agent=taskpatrol&log=1 → historial de alertas de ese agente
// POST /api/config?agent=taskpatrol   → guarda (merge) config de ese agente
//      body: { enabled?, schedule?, alertHours?, teamEmails?, customMessage? }

import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Registro de agentes del hub. Para sumar un agente nuevo más adelante,
// se agrega una entrada acá + su carpeta en api/agents/<id>/check.js
const AGENTS_REGISTRY = [
  {
    id: 'taskpatrol',
    name: 'Taskpatrol',
    description: 'Avisa por mail si hay menciones sin responder o tareas vencidas sin update.',
    defaultConfig: {
      enabled: true,
      schedule: '07:00',
      alertHours: 24,
      teamEmails: [
        'brenda@pow.la',
        'florencia@pow.la',
        'martina.arias@pow.la',
        'luciana@pow.la',
      ],
      customMessage: '',
    },
  },
];

function getAgentDef(agentId) {
  return AGENTS_REGISTRY.find((a) => a.id === agentId);
}

async function getAgentConfig(agentId) {
  const def = getAgentDef(agentId);
  if (!def) return null;
  const stored = (await redis.get(`agent:${agentId}:config`)) || {};
  return { ...def.defaultConfig, ...stored };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { agent, log } = req.query;

  // --- Historial de un agente ---
  if (req.method === 'GET' && agent && log === '1') {
    if (!getAgentDef(agent)) {
      return res.status(404).json({ error: `Agente "${agent}" no existe` });
    }
    try {
      const items = await redis.lrange(`agent:${agent}:log`, 0, 49);
      const parsed = items.map((item) => {
        try {
          return typeof item === 'string' ? JSON.parse(item) : item;
        } catch {
          return item;
        }
      });
      return res.status(200).json({ log: parsed });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // --- Config de un agente puntual ---
  if (req.method === 'GET' && agent) {
    const config = await getAgentConfig(agent);
    if (!config) return res.status(404).json({ error: `Agente "${agent}" no existe` });
    return res.status(200).json(config);
  }

  // --- Lista de todos los agentes con su config actual ---
  if (req.method === 'GET') {
    try {
      const agents = await Promise.all(
        AGENTS_REGISTRY.map(async (def) => ({
          id: def.id,
          name: def.name,
          description: def.description,
          config: await getAgentConfig(def.id),
        }))
      );
      return res.status(200).json({ agents });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // --- Guardar config de un agente ---
  if (req.method === 'POST') {
    if (!agent) return res.status(400).json({ error: 'Falta el parámetro ?agent=' });
    const def = getAgentDef(agent);
    if (!def) return res.status(404).json({ error: `Agente "${agent}" no existe` });
    try {
      const current = await getAgentConfig(agent);
      const updated = { ...current, ...req.body };
      await redis.set(`agent:${agent}:config`, updated);
      return res.status(200).json({ ok: true, config: updated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
