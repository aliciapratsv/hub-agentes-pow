// api/agents/taskpatrol/check.js
// Lo dispara un scheduler externo (cron-job.org) cada 1 hora vía HTTP GET,
// con header: Authorization: Bearer <CRON_SECRET>
// Adentro se fija si corresponde correr según el "schedule" guardado en Redis.

import { Redis } from '@upstash/redis';
import nodemailer from 'nodemailer';

const redis = Redis.fromEnv();

const ASANA_TOKEN = process.env.ASANA_TOKEN;
const WORKSPACE_GID = process.env.ASANA_WORKSPACE_GID;
const CRON_SECRET = process.env.CRON_SECRET;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_PASS;
const ALICIA_EMAIL = process.env.ALICIA_EMAIL || 'alicia@pow.la';

const DEFAULT_CONFIG = {
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
};

async function asanaGet(path) {
  const r = await fetch(`https://app.asana.com/api/1.0${path}`, {
    headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  });
  const json = await r.json();
  if (!r.ok) throw new Error(json.errors?.[0]?.message || 'Error en Asana API');
  return json.data;
}

// schedule en formato "HH:MM", hora local Argentina (UTC-3, sin horario de verano)
function scheduleMatchesNow(schedule) {
  const [schedHour] = schedule.split(':').map(Number);
  const nowUtc = new Date();
  const localHour = (nowUtc.getUTCHours() - 3 + 24) % 24;
  return localHour === schedHour;
}

async function getTeamMembers(teamEmails) {
  const users = await asanaGet(
    `/workspaces/${WORKSPACE_GID}/users?opt_fields=gid,email,name&limit=100`
  );
  return users.filter((u) => teamEmails.includes(u.email));
}

async function getTasksForUser(userGid) {
  return await asanaGet(
    `/tasks?assignee=${userGid}&workspace=${WORKSPACE_GID}&completed_since=now&opt_fields=gid,name,due_on,modified_at,memberships.project.gid,memberships.project.name`
  );
}

async function getStories(taskGid) {
  return await asanaGet(
    `/tasks/${taskGid}/stories?opt_fields=type,text,created_at,created_by.gid,created_by.name&limit=50`
  );
}

function hoursSince(dateStr) {
  return (Date.now() - new Date(dateStr).getTime()) / 3600000;
}

async function checkTaskForMember(task, member, alertHours) {
  const alerts = [];
  const projectName = task.memberships?.[0]?.project?.name || 'Sin proyecto';

  // Tarea vencida sin update reciente
  if (task.due_on) {
    const dueDate = new Date(`${task.due_on}T23:59:59`);
    if (dueDate.getTime() < Date.now() && hoursSince(task.modified_at) >= alertHours) {
      const daysOverdue = Math.floor((Date.now() - dueDate.getTime()) / 86400000);
      alerts.push({
        type: 'overdue',
        assignee: member.name,
        assigneeEmail: member.email,
        taskName: task.name,
        projectName,
        detail: `Vencida el ${task.due_on} · ${daysOverdue}d de retraso sin actualizaciones`,
        ts: new Date().toISOString(),
      });
    }
  }

  // Mención sin respuesta hace más de alertHours
  try {
    const stories = await getStories(task.gid);
    const mentions = stories.filter(
      (s) =>
        s.type === 'comment' &&
        s.created_by?.gid !== member.gid &&
        s.text?.includes('@') &&
        hoursSince(s.created_at) >= alertHours
    );
    for (const mention of mentions) {
      const replied = stories.some(
        (s) =>
          s.type === 'comment' &&
          s.created_by?.gid === member.gid &&
          new Date(s.created_at) > new Date(mention.created_at)
      );
      if (!replied) {
        const hrs = Math.round(hoursSince(mention.created_at));
        alerts.push({
          type: 'mention',
          assignee: member.name,
          assigneeEmail: member.email,
          taskName: task.name,
          projectName,
          detail: `Mención sin respuesta hace ${hrs}hs`,
          ts: new Date().toISOString(),
        });
      }
    }
  } catch {
    // si falla la consulta de stories de una tarea puntual, seguimos con las demás
  }

  return alerts;
}

function emailTemplate(memberName, alerts, customMessage) {
  const rows = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#020001;background:${
            a.type === 'overdue' ? '#FFEB82' : '#FF722D'
          };">
            ${a.type === 'overdue' ? 'VENCIDA' : 'MENCIÓN'}
          </span>
        </td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;">${a.taskName}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;">${a.projectName}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #eee;color:#555;">${a.detail}</td>
      </tr>`
    )
    .join('');

  return `
  <div style="font-family: 'Helvetica Neue', Arial, sans-serif;max-width:600px;margin:0 auto;">
    <div style="background:#020001;padding:20px;">
      <span style="color:#FF722D;font-size:20px;font-weight:700;">Taskpatrol</span>
    </div>
    <div style="padding:20px;">
      <p>Hola ${memberName.split(' ')[0]},</p>
      <p>Tenés ${alerts.length} ${alerts.length === 1 ? 'pendiente' : 'pendientes'} en Asana que necesitan tu atención:</p>
      <table style="width:100%;border-collapse:collapse;margin-top:12px;">
        ${rows}
      </table>
      ${
        customMessage
          ? `<p style="margin-top:20px;padding:12px;background:#FFEB82;border-radius:6px;">${customMessage}</p>`
          : ''
      }
      <p style="margin-top:24px;color:#999;font-size:12px;">Este mail lo envía Taskpatrol automáticamente. No se publicó ningún comentario en Asana.</p>
    </div>
  </div>`;
}

async function sendEmail(to, cc, subject, html) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_PASS },
  });
  await transporter.sendMail({ from: `"Taskpatrol" <${GMAIL_USER}>`, to, cc, subject, html });
}

export default async function handler(req, res) {
  if (req.headers['authorization'] !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const stored = (await redis.get('agent:taskpatrol:config')) || {};
    const config = { ...DEFAULT_CONFIG, ...stored };

    if (!config.enabled) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'agente apagado' });
    }

    if (!scheduleMatchesNow(config.schedule)) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'no coincide el horario configurado',
        schedule: config.schedule,
      });
    }

    const members = await getTeamMembers(config.teamEmails);
    const alertsByMember = {};
    let totalAlerts = 0;

    for (const member of members) {
      const tasks = await getTasksForUser(member.gid);
      const memberAlerts = [];
      for (const task of tasks) {
        memberAlerts.push(...(await checkTaskForMember(task, member, config.alertHours)));
      }
      if (memberAlerts.length > 0) {
        alertsByMember[member.email] = { member, alerts: memberAlerts };
        totalAlerts += memberAlerts.length;
      }
    }

    let emailsSent = 0;
    for (const email in alertsByMember) {
      const { member, alerts } = alertsByMember[email];
      await sendEmail(
        member.email,
        ALICIA_EMAIL,
        `[Taskpatrol] Tenés ${alerts.length} pendiente${alerts.length > 1 ? 's' : ''} en Asana`,
        emailTemplate(member.name, alerts, config.customMessage)
      );
      emailsSent++;
      for (const alert of alerts) {
        await redis.lpush('agent:taskpatrol:log', JSON.stringify(alert));
      }
    }
    if (totalAlerts > 0) {
      await redis.ltrim('agent:taskpatrol:log', 0, 99);
    }

    await redis.set('agent:taskpatrol:last_run', {
      ts: new Date().toISOString(),
      emailsSent,
      totalAlerts,
    });

    return res.status(200).json({ ok: true, emailsSent, totalAlerts, checked: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
