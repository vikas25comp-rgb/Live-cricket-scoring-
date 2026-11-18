import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)

  try {
    const authorization = request.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required.' }, 401)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: callerData, error: callerError } = await callerClient.auth.getUser()
    if (callerError || !callerData.user) return json({ error: 'Invalid or expired session.' }, 401)

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: callerProfile, error: roleError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', callerData.user.id)
      .maybeSingle()

    if (roleError || callerProfile?.role !== 'administrator') {
      return json({ error: 'Administrator permission is required.' }, 403)
    }

    const body = await request.json()
    const email = String(body.email || '').trim().toLowerCase()
    const password = String(body.password || '')
    const role = String(body.role || 'scorer')

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: 'Enter a valid email address.' }, 400)
    }
    if (password.length < 8) return json({ error: 'Password must contain at least 8 characters.' }, 400)
    if (!['administrator', 'scorer'].includes(role)) {
      return json({ error: 'Only administrator or scorer accounts can be created.' }, 400)
    }

    const { data: created, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createError || !created.user) return json({ error: createError?.message || 'Could not create user.' }, 400)

    const { error: profileError } = await adminClient
      .from('profiles')
      .upsert({ id: created.user.id, email, role }, { onConflict: 'id' })

    if (profileError) {
      await adminClient.auth.admin.deleteUser(created.user.id)
      return json({ error: `Profile creation failed: ${profileError.message}` }, 500)
    }

    return json({ success: true, user: { id: created.user.id, email, role } }, 201)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Unexpected server error.' }, 500)
  }
})
