// Invite someone to the tracker. Called from the Members page by any signed-in reader.
// Sign-up is disabled, so sending invitations needs the service key, which lives only here.
//
// POST { email } with the reader's session token. Replies { status, message }, where status is
//   invited  - a new invitation email was sent
//   resent   - they were invited before but haven't joined, so they got a fresh sign-in link
//   member   - they have already joined; nothing was sent
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const DAILY_LIMIT = 20;          // new invitations per reader per 24 hours
const RESEND_WAIT_MINUTES = 10;  // between links to the same address

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const anon = createClient(url, anonKey, { auth: { persistSession: false } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { message: 'Use POST.' });

  // Only signed-in readers who have set up their profile can invite
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(token);
  const caller = auth?.user;
  if (!caller) return reply(401, { message: 'Your session expired. Please sign in again.' });
  const { data: me } = await admin.from('readers').select('user_id').eq('user_id', caller.id).maybeSingle();
  if (!me) return reply(403, { message: 'Set up your profile before inviting people.' });

  let email = '';
  try { email = String((await req.json()).email || '').trim().toLowerCase(); } catch { /* handled below */ }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return reply(400, { message: `"${email}" is not a valid email address.` });
  }

  const { data: existingId, error: lookupError } = await admin.rpc('auth_user_id', { p_email: email });
  if (lookupError) return reply(500, { message: lookupError.message });
  const { data: invite } = await admin.from('invites').select('*').eq('email', email).maybeSingle();

  if (existingId) {
    const { data: member } = await admin.from('readers').select('display_name').eq('user_id', existingId).maybeSingle();
    if (member) return reply(200, { status: 'member', message: `${member.display_name} has already joined.` });

    // Invited before but never finished joining: send a fresh sign-in link
    if (invite && Date.now() - Date.parse(invite.last_sent_at) < RESEND_WAIT_MINUTES * 60_000) {
      return reply(429, { message: `A link was sent to ${email} a few minutes ago. Please wait before sending another.` });
    }
    const { error } = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    if (error) return reply(error.status || 500, { message: error.message });
    const row = { user_id: existingId, last_sent_at: new Date().toISOString() };
    const { error: saveError } = invite
      ? await admin.from('invites').update(row).eq('email', email)
      : await admin.from('invites').insert({ ...row, email, invited_by: caller.id });
    if (saveError) return reply(500, { message: saveError.message });
    return reply(200, { status: 'resent', message: `${email} was already invited, so they've been sent a new sign-in link.` });
  }

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await admin.from('invites').select('email', { count: 'exact', head: true })
    .eq('invited_by', caller.id).gte('created_at', since);
  if ((count || 0) >= DAILY_LIMIT) {
    return reply(429, { message: `You've sent ${DAILY_LIMIT} invitations today. Please try again tomorrow.` });
  }

  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email);
  if (error) return reply(error.status || 500, { message: error.message });
  const now = new Date().toISOString();
  const { error: saveError } = await admin.from('invites').upsert({
    email, user_id: invited.user.id, invited_by: caller.id, created_at: now, last_sent_at: now,
  });
  if (saveError) return reply(500, { message: saveError.message });
  return reply(200, { status: 'invited', message: `Invitation sent to ${email}.` });
});
