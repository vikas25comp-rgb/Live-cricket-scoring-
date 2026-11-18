# Harmony Sports Association – Supabase setup

## 1. Frontend environment

Create `.env` in the project root (next to `package.json`):

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Never put the Supabase `service_role` key in `.env` or any `VITE_` variable.

## 2. Existing role database

This application expects the role migration already discussed and applied in Supabase:

- `public.profiles` with `id`, `email`, and `role` (`administrator`, `scorer`, or `viewer`).
- A profile row for every Auth user.
- RLS policies that let a user read their own profile, let administrators read/update profiles, and let only administrators/scorers modify cricket match data.
- Public read-only policies for spectator-visible match data.

The first administrator profile must be assigned manually in the Supabase SQL editor. Do not allow public signup.

## 3. Enable Realtime

Run `supabase/migrations/20261118_enable_cricket_realtime.sql` in the Supabase SQL editor. This enables database change events for matches, innings, ball events, score adjustments, and stream links. The public page uses these events to reload a consistent scoreboard snapshot.

## 4. Deploy secure administrator account creation

From the project root, install and log in to the Supabase CLI if needed, link the project, then deploy the Edge Function:

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase functions deploy admin-create-user
```

The hosted Supabase Edge Function receives `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase function environment. The service-role key is used only inside the server-side Edge Function and must never be copied into the React application.

If the function environment does not already expose the standard Supabase secrets, configure them in the Supabase Dashboard under Edge Functions / Secrets. Never paste the service-role key into chat or a frontend file.

## 5. Run locally

```powershell
npm install
npm run dev
```

Open the local URL printed by Vite. Public spectators use the normal website URL. Authorized staff use the `STAFF LOGIN` link or append `?login=1` to the URL.

## 6. Build and deploy

```powershell
npm run build
```

Deploy the generated `dist` folder using the hosting provider already used by the project.

## Important access behavior

- Public page: no login, no scoring or admin controls.
- Staff login: `?login=1`; only `administrator` and `scorer` profiles are accepted.
- Scorer: match/scoring controls.
- Administrator: scorer controls plus account management and stream-link administration.
- OBS overlay: existing `?overlay=1` route is preserved.
