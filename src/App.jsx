import { useEffect, useMemo, useState } from 'react'
import { supabase } from './supabaseClient'
import './App.css'

const DEFAULT_CAMERA = 'https://vdo.ninja/?view=4vHi8Ta'

const DISMISSALS = [
  'bowled', 'caught', 'lbw', 'stumped', 'run out',
  'hit wicket', 'caught and bowled', 'retired out',
  'obstructing the field', 'hit the ball twice'
]

const emptyBatter = name => ({
  name, runs: 0, balls: 0, fours: 0, sixes: 0, out: false
})

function getEmbedUrl(rawLink) {
  if (!rawLink?.trim()) return null

  try {
    let value = rawLink.trim()
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '')

    if (
      host === 'vdo.ninja' ||
      host.endsWith('.vdo.ninja') ||
      host === 'obs.ninja' ||
      host.endsWith('.obs.ninja')
    ) {
      return url.toString()
    }

    const isShort = host === 'youtu.be'
    const isYoutube =
      host === 'youtube.com' ||
      host.endsWith('.youtube.com') ||
      host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com')

    if (!isShort && !isYoutube) return null

    let id = ''

    if (isShort) {
      id = url.pathname.split('/').filter(Boolean)[0] || ''
    } else {
      id =
        url.searchParams.get('v') ||
        url.pathname.match(/^\/(?:embed|live|shorts|v)\/([^/?]+)/i)?.[1] ||
        ''
    }

    if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) return null

    const params = new URLSearchParams({
      autoplay: '1',
      rel: '0'
    })

    const start = url.searchParams.get('start') || url.searchParams.get('t')

    if (start && /^\d+$/.test(start)) {
      params.set('start', start)
    }

    return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`
  } catch {
    return null
  }
}

function getPlayerStats(events = []) {
  const batters = {}
  const bowlers = {}

  events.forEach(event => {
    const batterName = event.batter_name || 'Unknown batter'
    const bowlerName = event.bowler_name || 'Unknown bowler'

    if (!batters[batterName]) {
      batters[batterName] = emptyBatter(batterName)
    }

    if (!bowlers[bowlerName]) {
      bowlers[bowlerName] = {
        name: bowlerName,
        runs: 0,
        wickets: 0,
        balls: 0
      }
    }

    const batter = batters[batterName]
    const bowler = bowlers[bowlerName]

    const batRuns = Number(
      event.batsman_runs ?? event.runs_scored ?? 0
    )

    batter.runs += batRuns

    if (event.batter_ball !== false) {
      batter.balls += 1
    }

    if (batRuns === 4) batter.fours += 1
    if (batRuns === 6) batter.sixes += 1

    if (event.is_wicket && event.dismissed_player_name) {
      const name = event.dismissed_player_name

      if (!batters[name]) {
        batters[name] = emptyBatter(name)
      }

      batters[name].out = true
    }

    if (event.bowler_charged !== false) {
      bowler.runs +=
        batRuns +
        Number(event.wide_runs || 0) +
        Number(event.no_ball_runs || 0)
    }

    if (event.is_legal_delivery) {
      bowler.balls += 1
    }

    if (
      event.is_wicket &&
      ![
        'run out',
        'retired out',
        'obstructing the field',
        'hit the ball twice'
      ].includes(String(event.dismissal_type || '').toLowerCase())
    ) {
      bowler.wickets += 1
    }
  })

  return {
    batters: Object.values(batters),
    bowlers: Object.values(bowlers)
  }
}


function BroadcastScoreOverlay({ matchId: requestedMatchId = null, obsMode = false }) {
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    let timer

    const refresh = async () => {
      try {
        let matchQuery = supabase
          .from('matches')
          .select('*')

        if (requestedMatchId) {
          matchQuery = matchQuery.eq('id', requestedMatchId)
        } else {
          matchQuery = matchQuery.order('created_at', { ascending: false }).limit(1)
        }

        const { data: matchData, error: matchError } = requestedMatchId
          ? await matchQuery.maybeSingle()
          : await matchQuery.maybeSingle()
        if (matchError) throw matchError
        if (!matchData) {
          if (active) {
            setSnapshot(null)
            setLoading(false)
          }
          return
        }

        const [teamsResult, inningsResult] = await Promise.all([
          supabase
            .from('teams')
            .select('id,name')
            .in('id', [matchData.team_a_id, matchData.team_b_id]),
          supabase
            .from('innings')
            .select('*')
            .eq('match_id', matchData.id)
            .order('innings_number', { ascending: false })
            .limit(1)
        ])

        if (teamsResult.error) throw teamsResult.error
        if (inningsResult.error) throw inningsResult.error

        const inning = inningsResult.data?.[0]
        if (!inning) {
          if (active) {
            setSnapshot({ match: matchData, teamA: 'TEAM A', teamB: 'TEAM B', inning: null })
            setLoading(false)
          }
          return
        }

        const [eventsResult, adjustmentsResult] = await Promise.all([
          supabase
            .from('ball_events')
            .select('*')
            .eq('innings_id', inning.id)
            .order('delivery_sequence', { ascending: true }),
          supabase
            .from('score_adjustments')
            .select('runs')
            .eq('innings_id', inning.id)
            .is('undone_at', null)
        ])

        if (eventsResult.error) throw eventsResult.error
        if (adjustmentsResult.error) throw adjustmentsResult.error

        const teams = teamsResult.data || []
        const teamA = teams.find(team => team.id === matchData.team_a_id)?.name || 'TEAM A'
        const teamB = teams.find(team => team.id === matchData.team_b_id)?.name || 'TEAM B'
        const battingTeam = inning.batting_team_id === matchData.team_a_id ? teamA : teamB
        const stats = getPlayerStats(eventsResult.data || [])
        const strikerName = inning.striker_name || 'Batter 1'
        const nonStrikerName = inning.non_striker_name || 'Batter 2'
        const bowlerName = inning.current_bowler_name || 'Bowler 1'
        const batters = [
          stats.batters.find(player => player.name === strikerName) || emptyBatter(strikerName),
          stats.batters.find(player => player.name === nonStrikerName) || emptyBatter(nonStrikerName)
        ]
        const bowler = stats.bowlers.find(player => player.name === bowlerName) || {
          name: bowlerName, runs: 0, wickets: 0, balls: 0
        }
        const legalBalls = Number(inning.legal_balls || 0)
        const totalRuns = Number(inning.total_runs || 0)
        const recent = (eventsResult.data || []).slice(-6).map(event => {
          if (event.is_wicket) return 'W'
          if (Number(event.wide_runs || 0)) return `Wd${event.wide_runs}`
          if (Number(event.no_ball_runs || 0)) return `Nb${event.batsman_runs || 0}`
          if (Number(event.bye_runs || 0)) return `B${event.bye_runs}`
          if (Number(event.leg_bye_runs || 0)) return `Lb${event.leg_bye_runs}`
          return String(event.batsman_runs ?? event.runs_scored ?? 0)
        })
        const extras = (eventsResult.data || []).reduce((sum, event) => sum +
          Number(event.wide_runs || 0) + Number(event.no_ball_runs || 0) +
          Number(event.bye_runs || 0) + Number(event.leg_bye_runs || 0), 0) +
          (adjustmentsResult.data || []).reduce((sum, item) => sum + Number(item.runs || 0), 0)
        const maxBalls = inning.innings_type === 'SUPER_OVER'
          ? Number(matchData.super_over_balls || 6)
          : Number(inning.match_overs || matchData.overs_per_innings || 20) * 6

        if (active) {
          setSnapshot({
            match: matchData,
            teamA,
            teamB,
            battingTeam,
            inning,
            totalRuns,
            wickets: Number(inning.wickets || 0),
            legalBalls,
            overs: `${Math.floor(legalBalls / 6)}.${legalBalls % 6}`,
            runRate: legalBalls ? (totalRuns / (legalBalls / 6)).toFixed(2) : '0.00',
            target: Number(inning.target || 0),
            required: Number(inning.target || 0) > 0 ? Math.max(0, Number(inning.target) - totalRuns) : null,
            requiredRate: Number(inning.target || 0) > 0 && maxBalls > legalBalls
              ? ((Math.max(0, Number(inning.target) - totalRuns) / ((maxBalls - legalBalls) / 6))).toFixed(2)
              : null,
            extras,
            batters,
            bowler,
            recent,
            isSuper: inning.innings_type === 'SUPER_OVER',
            superOverNumber: Number(inning.super_over_number || 0),
            superOverInnings: Number(inning.super_over_innings || 0),
            completed: matchData.status === 'completed'
          })
          setLoading(false)
        }
      } catch (error) {
        console.error('Broadcast scoreboard refresh failed:', error)
        if (active) setLoading(false)
      }
    }

    refresh()
    timer = window.setInterval(refresh, 2500)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [requestedMatchId])

  if (!snapshot?.inning) {
    return (
      <div className={`broadcast-overlay ${obsMode ? 'broadcast-overlay-obs' : 'broadcast-overlay-player'}`}>
        <div className="broadcast-overlay-empty">
          {loading ? 'LOADING LIVE SCORE…' : 'WAITING FOR MATCH SCORE'}
        </div>
      </div>
    )
  }

  const { battingTeam, inning, totalRuns, wickets, overs, runRate, target,
    required, requiredRate, batters, bowler, recent, extras, isSuper,
    superOverNumber, superOverInnings, completed } = snapshot

  return (
    <div className={`broadcast-overlay ${obsMode ? 'broadcast-overlay-obs' : 'broadcast-overlay-player'}`}>
      <div className="broadcast-overlay-topline">
        <span className="broadcast-overlay-brand">HARMONY SPORTS ASSOCIATION</span>
        <span className={`broadcast-overlay-live ${completed ? 'is-complete' : ''}`}>
          <i /> {completed ? 'FULL TIME' : 'LIVE'}
        </span>
      </div>
      <div className="broadcast-overlay-main">
        <div className="broadcast-overlay-team">
          <span>{battingTeam}</span>
          <strong>{totalRuns}<em>/{wickets}</em></strong>
          <small>{overs} OVERS {isSuper ? `· SUPER OVER ${superOverNumber}.${superOverInnings}` : ''}</small>
        </div>
        <div className="broadcast-overlay-metrics">
          <div><small>CRR</small><strong>{runRate}</strong></div>
          <div><small>EXTRAS</small><strong>{extras}</strong></div>
          {target > 0 && <div><small>TARGET</small><strong>{target}</strong></div>}
          {required !== null && <div><small>NEED</small><strong>{required}</strong></div>}
          {requiredRate !== null && <div><small>REQ RR</small><strong>{requiredRate}</strong></div>}
        </div>
      </div>
      <div className="broadcast-overlay-bottom">
        <div className="broadcast-overlay-batters">
          {batters.map((player, index) => (
            <span key={`${player.name}-${index}`}>
              <b>{player.name}{index === 0 ? ' *' : ''}</b>
              <strong>{player.runs}<small> ({player.balls})</small></strong>
            </span>
          ))}
        </div>
        <div className="broadcast-overlay-bowler">
          <b>{bowler.name}</b>
          <strong>{Math.floor(bowler.balls / 6)}.{bowler.balls % 6}-{bowler.runs}-{bowler.wickets}</strong>
        </div>
        <div className="broadcast-overlay-recent">
          <small>LAST BALLS</small>
          {recent.map((ball, index) => (
            <i key={`${ball}-${index}`} className={ball === 'W' ? 'is-wicket' : ['4', '6'].includes(ball) ? 'is-boundary' : ''}>{ball}</i>
          ))}
        </div>
      </div>
    </div>
  )
}


function MainWebsite() {
  // Broadcast
  const [cameraLink, setCameraLink] = useState(DEFAULT_CAMERA)
  const [streamLinkInput, setStreamLinkInput] = useState(DEFAULT_CAMERA)
  const [streamMessage, setStreamMessage] = useState('')

  const embedUrl = getEmbedUrl(cameraLink)

  // Authentication
  const [session, setSession] = useState(null)
  const [userRole, setUserRole] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const isLoginPage = new URLSearchParams(window.location.search).get('login') === '1'
  const canManage = Boolean(session && ['administrator', 'scorer'].includes(userRole))
  const isAdministrator = Boolean(session && userRole === 'administrator')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMessage, setAuthMessage] = useState('')
  const [staffAccounts, setStaffAccounts] = useState([])
  const [newStaffEmail, setNewStaffEmail] = useState('')
  const [newStaffPassword, setNewStaffPassword] = useState('')
  const [newStaffRole, setNewStaffRole] = useState('scorer')
  const [accountMessage, setAccountMessage] = useState('')

  // General
  const [busy, setBusy] = useState(false)
  const [scoreMessage, setScoreMessage] = useState('')

  // Match setup
  const [teamA, setTeamA] = useState('TEAM A')
  const [teamB, setTeamB] = useState('TEAM B')
  const [battingFirst, setBattingFirst] = useState('A')
  const [matchFormat, setMatchFormat] = useState('T20')
  const [customOvers, setCustomOvers] = useState(20)
  const [matchOvers, setMatchOvers] = useState(20)
  const [maxWickets, setMaxWickets] = useState(10)

  // Super Over settings
  const [superOverOvers, setSuperOverOvers] = useState(1)
  const [superOverBalls, setSuperOverBalls] = useState(6)
  const [superOverWickets, setSuperOverWickets] = useState(2)
  const [superOverNumber, setSuperOverNumber] = useState(0)
  const [inningsType, setInningsType] = useState('MAIN')
  const [superOverInnings, setSuperOverInnings] = useState(0)
  const [mainFirstRuns, setMainFirstRuns] = useState(null)
  const [superFirstRuns, setSuperFirstRuns] = useState(null)

  // Database
  const [matchId, setMatchId] = useState(null)
  const [teamAId, setTeamAId] = useState(null)
  const [teamBId, setTeamBId] = useState(null)
  const [inningsId, setInningsId] = useState(null)
  const [innings, setInnings] = useState(1)
  const [matchStarted, setMatchStarted] = useState(false)
  const [inningsStatus, setInningsStatus] = useState('not_started')
  const [matchStatus, setMatchStatus] = useState('not_started')

  // Score
  const [runs, setRuns] = useState(0)
  const [wickets, setWickets] = useState(0)
  const [balls, setBalls] = useState(0)
  const [freeHitNext, setFreeHitNext] = useState(false)
  const [events, setEvents] = useState([])
  const [target, setTarget] = useState(0)
  const [inningsBallLimit, setInningsBallLimit] = useState(120)
  const [inningsMaxWickets, setInningsMaxWickets] = useState(10)

  // Players
  const [strikerName, setStrikerName] = useState('Batter 1')
  const [nonStrikerName, setNonStrikerName] = useState('Batter 2')
  const [bowlerName, setBowlerName] = useState('Bowler 1')
  const [newBatter, setNewBatter] = useState('')
  const [newBowler, setNewBowler] = useState('')
  const [dismissalType, setDismissalType] = useState('bowled')
  const [dismissedPlayer, setDismissedPlayer] = useState('striker')

  // Run-out controls
  const [runOutRuns, setRunOutRuns] = useState(0)
  const [runOutCrossed, setRunOutCrossed] = useState(true)
  const [fielderName, setFielderName] = useState('')

  // Extras
  const [wideAdditional, setWideAdditional] = useState(0)
  const [noBallBatRuns, setNoBallBatRuns] = useState(0)
  const [noBallRunType, setNoBallRunType] = useState('bat')
  const [byeRuns, setByeRuns] = useState(1)
  const [legByeRuns, setLegByeRuns] = useState(1)

  // Penalty adjustments
  const [penaltyRuns, setPenaltyRuns] = useState(5)
  const [penaltyReason, setPenaltyReason] = useState('')
  const [penaltyTeam, setPenaltyTeam] = useState('batting')

  // Results
  const [savedResult, setSavedResult] = useState('')
  const [resultText, setResultText] = useState('')

  // History
  const [inningsHistory, setInningsHistory] = useState([])
  const [adjustments, setAdjustments] = useState([])

  const totalBalls = inningsBallLimit
  const overs = `${Math.floor(balls / 6)}.${balls % 6}`
  const runRate = balls
    ? (runs / (balls / 6)).toFixed(2)
    : '0.00'

  const battingTeam = battingFirst === 'A' ? teamA : teamB
  const bowlingTeam = battingFirst === 'A' ? teamB : teamA

  const inningsComplete =
    balls >= totalBalls ||
    wickets >= inningsMaxWickets ||
    (target > 0 && runs >= target)

  const canScore = Boolean(
    canManage &&
    inningsId &&
    matchStarted &&
    inningsStatus !== 'completed' &&
    matchStatus !== 'completed' &&
    !busy &&
    !savedResult
  )

  const playerStats = useMemo(
    () => getPlayerStats(events),
    [events]
  )

  const battingStats = playerStats.batters
  const bowlingStats = playerStats.bowlers

  const currentBatters = [
    battingStats.find(b => b.name === strikerName) ||
      emptyBatter(strikerName),
    battingStats.find(b => b.name === nonStrikerName) ||
      emptyBatter(nonStrikerName)
  ]

  const currentBowlerStats =
    bowlingStats.find(b => b.name === bowlerName) ||
    {
      name: bowlerName,
      runs: 0,
      wickets: 0,
      balls: 0
    }

  const obsOverlayUrl = `${window.location.origin}${window.location.pathname}?overlay=1${matchId ? `&match=${matchId}` : ''}`

  const currentExtras =
    events.reduce((sum, event) =>
      sum +
      Number(event.wide_runs || 0) +
      Number(event.no_ball_runs || 0) +
      Number(event.bye_runs || 0) +
      Number(event.leg_bye_runs || 0), 0
    ) +
    adjustments.reduce(
      (sum, item) => sum + Number(item.runs || 0),
      0
    )

  const currentLastBalls = events
    .filter(event => event.is_legal_delivery)
    .slice(-6)
    .map(event => {
      if (event.is_wicket) return 'W'
      if (Number(event.wide_runs || 0)) {
        return `Wd${event.wide_runs}`
      }
      if (Number(event.no_ball_runs || 0)) {
        return `Nb${event.batsman_runs || 0}`
      }
      if (Number(event.bye_runs || 0)) {
        return `B${event.bye_runs}`
      }
      if (Number(event.leg_bye_runs || 0)) {
        return `Lb${event.leg_bye_runs}`
      }
      return String(event.batsman_runs ?? event.runs_scored ?? 0)
    })

  // Display every delivery in the current over, including wides and no-balls.
  const currentOverEvents = (() => {
    let legalBefore = 0
    const overIndexNow = Math.floor(balls / 6)
    const selected = []

    events.forEach(event => {
      const eventOverIndex = Math.floor(legalBefore / 6)

      if (eventOverIndex === overIndexNow) {
        selected.push(event)
      }

      if (event.is_legal_delivery) {
        legalBefore += 1
      }
    })

    return selected
  })()

  const formatBall = event => {
    const runsOnBall = Number(
      event.total_runs ||
      Number(event.batsman_runs || 0) +
      Number(event.wide_runs || 0) +
      Number(event.no_ball_runs || 0) +
      Number(event.bye_runs || 0) +
      Number(event.leg_bye_runs || 0)
    )

    if (event.is_wicket) {
      return runsOnBall > 0 ? `W+${runsOnBall}` : 'W'
    }

    if (Number(event.wide_runs || 0)) {
      return `Wd${event.wide_runs}`
    }

    if (Number(event.no_ball_runs || 0)) {
      const extras =
        Number(event.bye_runs || 0) +
        Number(event.leg_bye_runs || 0)

      return extras
        ? `Nb+${extras}`
        : `Nb${event.batsman_runs || 0}`
    }

    if (Number(event.bye_runs || 0)) {
      return `B${event.bye_runs}`
    }

    if (Number(event.leg_bye_runs || 0)) {
      return `Lb${event.leg_bye_runs}`
    }

    return String(event.batsman_runs ?? event.runs_scored ?? 0)
  }

  // Authentication and database-backed role resolution.
  useEffect(() => {
    let active = true

    const resolveSession = async nextSession => {
      if (!active) return
      setSession(nextSession)
      setUserRole(null)

      if (!nextSession?.user?.id) {
        setAuthLoading(false)
        return
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', nextSession.user.id)
        .maybeSingle()

      if (!active) return
      if (error) {
        setAuthMessage(`Could not verify account role: ${error.message}`)
      }
      setUserRole(profile?.role || null)
      setAuthLoading(false)
    }

    supabase.auth.getSession().then(({ data }) => resolveSession(data.session))

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        Promise.resolve().then(() => resolveSession(nextSession))
      }
    )

    return () => {
      active = false
      listener.subscription.unsubscribe()
    }
  }, [])

  // Keep public spectators synchronized with live database changes.
  // A refresh reloads the complete match snapshot so innings, player changes,
  // undo operations, stream changes and Super Overs stay consistent together.
  useEffect(() => {
    if (canManage) return undefined

    let refreshQueued = false
    const refreshPublicScore = () => {
      if (refreshQueued || document.visibilityState === 'hidden') return
      refreshQueued = true
      window.setTimeout(() => window.location.reload(), 700)
    }

    const channel = supabase
      .channel('public-cricket-live-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches' }, refreshPublicScore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'innings' }, refreshPublicScore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ball_events' }, refreshPublicScore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'score_adjustments' }, refreshPublicScore)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stream_links' }, refreshPublicScore)
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [canManage])

  // Administrator-only staff account directory.
  useEffect(() => {
    if (!isAdministrator) {
      setStaffAccounts([])
      return undefined
    }

    let active = true
    const loadStaffAccounts = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id,email,role')
        .order('email', { ascending: true })

      if (!active) return
      if (error) {
        setAccountMessage(`Could not load accounts: ${error.message}`)
      } else {
        setStaffAccounts(data || [])
      }
    }

    loadStaffAccounts()
    return () => { active = false }
  }, [isAdministrator])

  const createStaffAccount = async event => {
    event.preventDefault()
    if (!isAdministrator) return
    if (!newStaffEmail.trim() || newStaffPassword.length < 8) {
      setAccountMessage('Enter a valid email and a password of at least 8 characters.')
      return
    }

    setBusy(true)
    setAccountMessage('Creating account...')
    try {
      const { data, error } = await supabase.functions.invoke('admin-create-user', {
        body: {
          email: newStaffEmail.trim(),
          password: newStaffPassword,
          role: newStaffRole
        }
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)
      setAccountMessage(`Account created for ${newStaffEmail.trim()}.`)
      setNewStaffEmail('')
      setNewStaffPassword('')
      const { data: refreshed, error: refreshError } = await supabase
        .from('profiles')
        .select('id,email,role')
        .order('email', { ascending: true })
      if (refreshError) throw refreshError
      setStaffAccounts(refreshed || [])
    } catch (error) {
      setAccountMessage(`Account creation failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  const updateStaffRole = async (userId, nextRole) => {
    if (!isAdministrator || userId === session?.user?.id) return
    setBusy(true)
    setAccountMessage('Updating account role...')
    const { error } = await supabase
      .from('profiles')
      .update({ role: nextRole })
      .eq('id', userId)
    if (error) {
      setAccountMessage(`Role update failed: ${error.message}`)
    } else {
      setStaffAccounts(current => current.map(account =>
        account.id === userId ? { ...account, role: nextRole } : account
      ))
      setAccountMessage('Account role updated.')
    }
    setBusy(false)
  }

  // Load latest match
  useEffect(() => {
    let cancelled = false

    async function loadLatestMatch() {
      const { data: match, error } = await supabase
        .from('matches')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (cancelled || error || !match) return

      const { data: teams } = await supabase
        .from('teams')
        .select('id,name')
        .in('id', [match.team_a_id, match.team_b_id])

      if (cancelled) return

      const a = teams?.find(t => t.id === match.team_a_id)
      const b = teams?.find(t => t.id === match.team_b_id)

      if (a) {
        setTeamA(a.name)
        setTeamAId(a.id)
      }

      if (b) {
        setTeamB(b.name)
        setTeamBId(b.id)
      }

      setMatchId(match.id)
      setMatchFormat(match.match_format || 'T20')
      setMatchOvers(Number(match.overs_per_innings || 20))
      setMaxWickets(Number(match.max_wickets || 10))
      setSuperOverOvers(Number(match.super_over_overs || 1))
      setSuperOverBalls(Number(match.super_over_balls || 6))
      setSuperOverWickets(Number(match.super_over_max_wickets || 2))
      setSuperOverNumber(Number(match.super_over_count || 0))

      const { data: allInnings } = await supabase
        .from('innings')
        .select('*')
        .eq('match_id', match.id)
        .order('innings_number', { ascending: true })

      if (cancelled || !allInnings?.length) return

      setInningsHistory(allInnings)

      const current = allInnings[allInnings.length - 1]

      if (
        current.innings_type === 'SUPER_OVER' &&
        Number(current.super_over_innings) === 2
      ) {
        const matchingFirst = allInnings.find(row =>
          row.innings_type === 'SUPER_OVER' &&
          Number(row.super_over_number) === Number(current.super_over_number) &&
          Number(row.super_over_innings) === 1
        )

        setSuperFirstRuns(
          matchingFirst
            ? Number(matchingFirst.total_runs || 0)
            : null
        )
      } else {
        setSuperFirstRuns(null)
      }

      const currentBatting =
        current.batting_team_id === match.team_b_id ? 'B' : 'A'

      setInningsId(current.id)
      setInnings(current.innings_number)
      setBattingFirst(currentBatting)
      setInningsType(current.innings_type || 'MAIN')
      setSuperOverInnings(Number(current.super_over_innings || 0))
      setMatchStarted(match.status === 'live')
      setMatchStatus(match.status || 'live')
      setInningsStatus(current.status || 'in_progress')

      setStrikerName(current.striker_name || 'Batter 1')
      setNonStrikerName(current.non_striker_name || 'Batter 2')
      setBowlerName(current.current_bowler_name || 'Bowler 1')

      const limit = current.innings_type === 'SUPER_OVER'
        ? Number(match.super_over_balls || 6)
        : Number(current.match_overs || match.overs_per_innings || 20) * 6

      setInningsBallLimit(limit)
      setInningsMaxWickets(Number(current.max_wickets || 10))
      setTarget(Number(current.target || 0))
      setFreeHitNext(Boolean(current.free_hit_next))

      if (match.status === 'completed') {
        setSavedResult(match.result_text || 'Match completed')
      }

      setResultText(match.result_text || '')

      const { data: eventRows } = await supabase
        .from('ball_events')
        .select('*')
        .eq('innings_id', current.id)
        .order('delivery_sequence', { ascending: true })

      if (cancelled) return

      setEvents(eventRows || [])
      setRuns(Number(current.total_runs || 0))
      setWickets(Number(current.wickets || 0))
      setBalls(Number(current.legal_balls || 0))

      const { data: stream } = await supabase
        .from('stream_links')
        .select('stream_url')
        .eq('match_id', match.id)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (!cancelled && stream?.stream_url) {
        setCameraLink(stream.stream_url)
        setStreamLinkInput(stream.stream_url)
      }

      await loadAdjustments(current.id)
    }

    loadLatestMatch()

    return () => {
      cancelled = true
    }
  }, [])

  const loadAdjustments = async id => {
    const { data } = await supabase
      .from('score_adjustments')
      .select('*')
      .eq('innings_id', id)
      .is('undone_at', null)
      .order('created_at', { ascending: true })

    setAdjustments(data || [])
  }

  const loadEvents = async id => {
    const { data, error } = await supabase
      .from('ball_events')
      .select('*')
      .eq('innings_id', id)
      .order('delivery_sequence', { ascending: true })

    if (error) throw error

    const rows = data || []
    setEvents(rows)

    const { data: inningRow, error: inningError } = await supabase
      .from('innings')
      .select('*')
      .eq('id', id)
      .single()

    if (inningError) throw inningError

    setRuns(Number(inningRow.total_runs || 0))
    setWickets(Number(inningRow.wickets || 0))
    setBalls(Number(inningRow.legal_balls || 0))
    setFreeHitNext(Boolean(inningRow.free_hit_next))
    setInningsStatus(inningRow.status || 'in_progress')
    setStrikerName(inningRow.striker_name || 'Batter 1')
    setNonStrikerName(inningRow.non_striker_name || 'Batter 2')
    setBowlerName(inningRow.current_bowler_name || 'Bowler 1')

    await loadAdjustments(id)

    if (matchId) {
      const { data: historyRows } = await supabase
        .from('innings')
        .select('*')
        .eq('match_id', matchId)
        .order('innings_number', { ascending: true })

      if (historyRows) {
        setInningsHistory(historyRows)
      }
    }

    return rows
  }

  const signIn = async event => {
    event.preventDefault()
    setBusy(true)

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password
    })

    if (error) {
      setAuthMessage(error.message)
    } else {
      const { data: userData, error: profileError } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', (await supabase.auth.getUser()).data.user.id)
        .maybeSingle()

      if (profileError || !['administrator', 'scorer'].includes(userData?.role)) {
        await supabase.auth.signOut()
        setSession(null)
        setUserRole(null)
        setAuthMessage(profileError
          ? `Unable to verify your role: ${profileError.message}`
          : 'This account is not authorized as an administrator or scorer. Contact the administrator.'
        )
      } else {
        setUserRole(userData.role)
        setAuthMessage(`Signed in successfully as ${userData.role}.`)
      }
    }

    setBusy(false)
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    setSession(null)
    setUserRole(null)
    setAuthMessage('Signed out.')
  }

  // Record player changes in action history
  const savePlayerNames = async (
    nextStriker = strikerName,
    nextNonStriker = nonStrikerName,
    nextBowler = bowlerName
  ) => {
    if (!inningsId || !canManage) return

    setBusy(true)

    try {
      const before = {
        striker_name: strikerName,
        non_striker_name: nonStrikerName,
        current_bowler_name: bowlerName
      }

      const after = {
        striker_name: nextStriker,
        non_striker_name: nextNonStriker,
        current_bowler_name: nextBowler
      }

      const { error } = await supabase
        .from('match_action_history')
        .insert({
          match_id: matchId,
          innings_id: inningsId,
          action_type: 'PLAYER_NAMES',
          state_before: before,
          state_after: after
        })

      if (error) throw error

      const { error: updateError } = await supabase
        .from('innings')
        .update(after)
        .eq('id', inningsId)

      if (updateError) throw updateError

      setStrikerName(nextStriker)
      setNonStrikerName(nextNonStriker)
      setBowlerName(nextBowler)
      setScoreMessage('Player names saved.')
    } catch (error) {
      setScoreMessage(`Could not save names: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Create match
  const startMatch = async () => {
    if (!canManage) {
      setScoreMessage('Sign in with the scorer account first.')
      return
    }

    if (
      !teamA.trim() ||
      !teamB.trim() ||
      teamA.trim() === teamB.trim()
    ) {
      setScoreMessage('Enter two different team names.')
      return
    }

    const oversValue =
      matchFormat === 'T10' ? 10 :
      matchFormat === 'T20' ? 20 :
      matchFormat === 'ODI' ? 50 :
      Number(customOvers)

    if (
      !Number.isInteger(oversValue) ||
      oversValue < 1 ||
      oversValue > 50
    ) {
      setScoreMessage('Enter valid overs between 1 and 50.')
      return
    }

    if (
      !Number.isInteger(Number(maxWickets)) ||
      Number(maxWickets) < 1 ||
      Number(maxWickets) > 10
    ) {
      setScoreMessage('Maximum wickets must be between 1 and 10.')
      return
    }

    if (
      !Number.isInteger(Number(superOverBalls)) ||
      Number(superOverBalls) < 1 ||
      Number(superOverBalls) > 36 ||
      !Number.isInteger(Number(superOverWickets)) ||
      Number(superOverWickets) < 1 ||
      Number(superOverWickets) > 10
    ) {
      setScoreMessage('Super Over must have 1–36 legal balls and 1–10 wickets.')
      return
    }

    setBusy(true)

    try {
      const { data: a, error: ae } = await supabase
        .from('teams')
        .insert({ name: teamA.trim() })
        .select('id')
        .single()

      if (ae) throw ae

      const { data: b, error: be } = await supabase
        .from('teams')
        .insert({ name: teamB.trim() })
        .select('id')
        .single()

      if (be) throw be

      const { data: match, error: me } = await supabase
        .from('matches')
        .insert({
          team_a_id: a.id,
          team_b_id: b.id,
          status: 'live',
          match_format: matchFormat,
          overs_per_innings: oversValue,
          max_wickets: Number(maxWickets),
          super_over_overs: Number(superOverOvers),
          super_over_balls: Number(superOverBalls),
          super_over_max_wickets: Number(superOverWickets),
          super_over_count: 0,
          is_super_over_active: false
        })
        .select('*')
        .single()

      if (me) throw me

      const battingId = battingFirst === 'A' ? a.id : b.id
      const bowlingId = battingFirst === 'A' ? b.id : a.id

      const { data: inningRow, error: ie } = await supabase
        .from('innings')
        .insert({
          match_id: match.id,
          innings_number: 1,
          batting_team_id: battingId,
          bowling_team_id: bowlingId,
          match_overs: oversValue,
          max_wickets: Number(maxWickets),
          total_runs: 0,
          wickets: 0,
          legal_balls: 0,
          striker_name: 'Batter 1',
          non_striker_name: 'Batter 2',
          current_bowler_name: 'Bowler 1',
          status: 'in_progress',
          innings_type: 'MAIN'
        })
        .select('*')
        .single()

      if (ie) throw ie

      setTeamAId(a.id)
      setTeamBId(b.id)
      setMatchId(match.id)
      setInningsId(inningRow.id)
      setInnings(1)
      setInningsType('MAIN')
      setSuperOverNumber(0)
      setSuperOverInnings(0)
      setMainFirstRuns(null)
      setSuperFirstRuns(null)
      setTarget(0)
      setMatchOvers(oversValue)
      setInningsBallLimit(oversValue * 6)
      setInningsMaxWickets(Number(maxWickets))

      setRuns(0)
      setWickets(0)
      setBalls(0)
      setEvents([])
      setAdjustments([])
      setFreeHitNext(false)
      setStrikerName('Batter 1')
      setNonStrikerName('Batter 2')
      setBowlerName('Bowler 1')
      setMatchStarted(true)
      setMatchStatus('live')
      setInningsStatus('in_progress')
      setSavedResult('')
      setResultText('')
      setInningsHistory([inningRow])

      setScoreMessage('New match created successfully.')
    } catch (error) {
      setScoreMessage(`Could not start match: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Record one delivery
  const recordDelivery = async ({
    batsmanRuns = 0,
    wideRuns = 0,
    noBallRuns = 0,
    byeRunsValue = 0,
    legByeRunsValue = 0,
    completedRuns = 0,
    isLegal = true,
    batterBall = true,
    bowlerCharged = true,
    isWicket = false,
    dismissal = null,
    dismissedName = null,
    fielder = null,
    crossed = true
  }) => {
    if (!canScore || inningsComplete) return

    if (isWicket && !newBatter.trim()) {
      setScoreMessage('Enter the next batter name before recording a wicket.')
      return
    }

    if (
      isWicket &&
      freeHitNext &&
      ![
        'run out',
        'retired out',
        'obstructing the field',
        'hit the ball twice'
      ].includes(String(dismissal || '').toLowerCase())
    ) {
      setScoreMessage(
        'On a free hit, only run out, retired out, obstructing the field or hit the ball twice can be recorded as a dismissal.'
      )
      return
    }

    setBusy(true)

    try {
      let nextStriker = strikerName
      let nextNonStriker = nonStrikerName

      const runOutCrossing =
        isWicket && dismissal === 'run out' && crossed ? 1 : 0

      const rotate =
        (Number(completedRuns) + runOutCrossing) % 2 === 1

      if (rotate) {
        ;[nextStriker, nextNonStriker] = [
          nextNonStriker,
          nextStriker
        ]
      }

      if (isWicket) {
        if (dismissedName === nextStriker) {
          nextStriker = newBatter.trim()
        } else {
          nextNonStriker = newBatter.trim()
        }
      }

      const nextLegalBalls = balls + (isLegal ? 1 : 0)

      // Change ends after the sixth legal delivery of an over.
      if (
        isLegal &&
        nextLegalBalls > 0 &&
        nextLegalBalls % 6 === 0
      ) {
        ;[nextStriker, nextNonStriker] = [
          nextNonStriker,
          nextStriker
        ]
      }

      const { error } = await supabase.rpc('score_delivery_v2', {
        p_innings_id: inningsId,
        p_batter_name: strikerName,
        p_bowler_name: bowlerName,
        p_batsman_runs: Number(batsmanRuns),
        p_wide_runs: Number(wideRuns),
        p_no_ball_runs: Number(noBallRuns),
        p_bye_runs: Number(byeRunsValue),
        p_leg_bye_runs: Number(legByeRunsValue),
        p_penalty_runs: 0,
        p_completed_runs: Number(completedRuns),
        p_is_wicket: Boolean(isWicket),
        p_dismissal_type: dismissal,
        p_dismissed_player_name: dismissedName,
        p_fielder_name: fielder,
        p_is_legal_delivery: Boolean(isLegal),
        p_batter_ball: Boolean(batterBall),
        p_bowler_charged: Boolean(bowlerCharged),
        p_striker_after: nextStriker,
        p_non_striker_after: nextNonStriker,
        p_bowler_after: bowlerName
      })

      if (error) throw error

      setNewBatter('')
      setFielderName('')

      await loadEvents(inningsId)

      setScoreMessage('Delivery saved successfully.')
    } catch (error) {
      setScoreMessage(`Scoring failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Normal batting runs: 0, 1, 2, 3, 4, 6.
  const addRuns = amount => recordDelivery({
    batsmanRuns: amount,
    completedRuns: amount,
    isLegal: true
  })

  // Wide: mandatory 1 wide plus selected additional wide runs.
  const addWide = () => {
    const additional = Number(wideAdditional)

    recordDelivery({
      wideRuns: additional + 1,
      completedRuns: additional,
      isLegal: false,
      batterBall: false
    })
  }

  // No-ball: one mandatory no-ball plus bat runs, byes or leg-byes.
  const addNoBall = () => {
    const value = Number(noBallBatRuns)

    recordDelivery({
      batsmanRuns: noBallRunType === 'bat' ? value : 0,
      noBallRuns: 1,
      byeRunsValue: noBallRunType === 'bye' ? value : 0,
      legByeRunsValue: noBallRunType === 'leg_bye' ? value : 0,
      completedRuns: value,
      isLegal: false,
      batterBall: true,
      bowlerCharged: true
    })
  }

  // Bye and leg-bye deliveries.
  const addBye = (type, amount) => {
    const value = Number(amount)

    recordDelivery({
      byeRunsValue: type === 'bye' ? value : 0,
      legByeRunsValue: type === 'leg_bye' ? value : 0,
      completedRuns: value,
      isLegal: true,
      batterBall: true,
      bowlerCharged: false
    })
  }

  // Penalty runs are stored separately from delivery events.
  const addPenalty = async () => {
    const value = Number(penaltyRuns)
    const reason = penaltyReason.trim()

    if (!canScore || !reason) {
      setScoreMessage('Enter the reason for the penalty.')
      return
    }

    setBusy(true)

    try {
      const awardedTeamId = penaltyTeam === 'batting'
        ? (battingFirst === 'A' ? teamAId : teamBId)
        : (battingFirst === 'A' ? teamBId : teamAId)

      const before = {
        total_runs: runs,
        penalty_runs: adjustments.reduce(
          (sum, a) => sum + Number(a.runs),
          0
        )
      }

      const { data: adjustment, error } = await supabase
        .from('score_adjustments')
        .insert({
          match_id: matchId,
          innings_id: inningsId,
          team_id: awardedTeamId,
          runs: value,
          reason
        })
        .select('*')
        .single()

      if (error) throw error

      const { error: updateError } = await supabase
        .from('innings')
        .update({
          total_runs: runs + value,
          penalty_runs: Number(before.penalty_runs) + value
        })
        .eq('id', inningsId)

      if (updateError) throw updateError

      const { error: historyError } = await supabase
        .from('match_action_history')
        .insert({
          match_id: matchId,
          innings_id: inningsId,
          action_type: 'PENALTY',
          action_data: { adjustment_id: adjustment.id },
          state_before: before,
          state_after: {
            total_runs: runs + value,
            penalty_runs: Number(before.penalty_runs) + value
          }
        })

      if (historyError) throw historyError

      setRuns(prev => prev + value)
      setAdjustments(prev => [...prev, adjustment])
      setPenaltyReason('')
      setScoreMessage(`${value} penalty runs added. No ball was consumed.`)
    } catch (error) {
      setScoreMessage(`Penalty adjustment failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Wicket scoring.
  const addWicket = () => {
    const outName = dismissedPlayer === 'striker'
      ? strikerName
      : nonStrikerName

    if (dismissalType === 'run out') {
      recordDelivery({
        isWicket: true,
        dismissal: 'run out',
        dismissedName: outName,
        completedRuns: Number(runOutRuns),
        batsmanRuns: 0,
        isLegal: true,
        batterBall: true,
        fielder: fielderName.trim() || null,
        crossed: runOutCrossed
      })
    } else {
      recordDelivery({
        isWicket: true,
        dismissal: dismissalType,
        dismissedName: outName,
        isLegal: true,
        batterBall: true,
        fielder: fielderName.trim() || null
      })
    }
  }

  // Undo last delivery.
  const undoLastDelivery = async () => {
    if (!canManage || !inningsId || busy || !events.length) return

    if (!window.confirm('Undo the last delivery?')) return

    setBusy(true)

    try {
      const { error } = await supabase.rpc('undo_last_delivery_v2', {
        p_innings_id: inningsId
      })

      if (error) throw error

      await loadEvents(inningsId)

      setScoreMessage('Last delivery undone.')
    } catch (error) {
      setScoreMessage(`Undo failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Undo last penalty adjustment.
  const undoPenalty = async () => {
    if (!canManage || !inningsId || busy || !adjustments.length) return

    if (!window.confirm('Undo the latest penalty adjustment?')) return

    setBusy(true)

    try {
      const adjustment = adjustments[adjustments.length - 1]

      const { data: inningRow, error: readError } = await supabase
        .from('innings')
        .select('total_runs,penalty_runs')
        .eq('id', inningsId)
        .single()

      if (readError) throw readError

      const { error: markError } = await supabase
        .from('score_adjustments')
        .update({ undone_at: new Date().toISOString() })
        .eq('id', adjustment.id)

      if (markError) throw markError

      const { error: updateError } = await supabase
        .from('innings')
        .update({
          total_runs: Math.max(
            0,
            Number(inningRow.total_runs) - Number(adjustment.runs)
          ),
          penalty_runs: Math.max(
            0,
            Number(inningRow.penalty_runs) - Number(adjustment.runs)
          )
        })
        .eq('id', inningsId)

      if (updateError) throw updateError

      await loadEvents(inningsId)

      setScoreMessage('Penalty adjustment undone.')
    } catch (error) {
      setScoreMessage(`Penalty undo failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Undo the latest saved player-name action.
  const undoPlayerChange = async () => {
    if (!canManage || !inningsId || busy) return

    setBusy(true)

    try {
      const { data: action, error } = await supabase
        .from('match_action_history')
        .select('*')
        .eq('innings_id', inningsId)
        .eq('action_type', 'PLAYER_NAMES')
        .is('undone_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) throw error
      if (!action) throw new Error('No player-name change to undo.')

      const { error: updateError } = await supabase
        .from('innings')
        .update(action.state_before)
        .eq('id', inningsId)

      if (updateError) throw updateError

      const { error: historyError } = await supabase
        .from('match_action_history')
        .update({ undone_at: new Date().toISOString() })
        .eq('id', action.id)

      if (historyError) throw historyError

      await loadEvents(inningsId)

      setScoreMessage('Player-name change undone.')
    } catch (error) {
      setScoreMessage(`Undo failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Start second main innings.
  const startSecondInnings = async () => {
    if (!canManage || !matchId || innings !== 1 || !inningsComplete) {
      setScoreMessage('Complete the first innings first.')
      return
    }

    setBusy(true)

    try {
      const first = await supabase
        .from('innings')
        .select('*')
        .eq('match_id', matchId)
        .eq('innings_number', 1)
        .single()

      if (first.error) throw first.error

      const firstRuns = Number(first.data.total_runs || 0)
      setMainFirstRuns(firstRuns)

      const firstBattingId = first.data.batting_team_id
      const secondBattingId = first.data.bowling_team_id

      const { data: second, error } = await supabase
        .from('innings')
        .insert({
          match_id: matchId,
          innings_number: 2,
          batting_team_id: secondBattingId,
          bowling_team_id: firstBattingId,
          match_overs: matchOvers,
          max_wickets: Number(first.data.max_wickets || maxWickets),
          total_runs: 0,
          wickets: 0,
          legal_balls: 0,
          striker_name: 'Batter 1',
          non_striker_name: 'Batter 2',
          current_bowler_name: 'Bowler 1',
          target: firstRuns + 1,
          status: 'in_progress',
          innings_type: 'MAIN'
        })
        .select('*')
        .single()

      if (error) throw error

      await supabase
        .from('innings')
        .update({ status: 'completed' })
        .eq('id', inningsId)

      setInningsId(second.id)
      setInnings(2)
      setBattingFirst(battingFirst === 'A' ? 'B' : 'A')
      setTarget(firstRuns + 1)
      setInningsType('MAIN')
      setSuperOverInnings(0)
      setInningsBallLimit(matchOvers * 6)
      setInningsMaxWickets(
        Number(first.data.max_wickets || maxWickets)
      )
      setRuns(0)
      setWickets(0)
      setBalls(0)
      setEvents([])
      setAdjustments([])
      setFreeHitNext(false)
      setStrikerName('Batter 1')
      setNonStrikerName('Batter 2')
      setBowlerName('Bowler 1')
      setInningsStatus('in_progress')
      setInningsHistory(prev => [...prev, second])

      setScoreMessage(`Second innings started. Target: ${firstRuns + 1}.`)
    } catch (error) {
      setScoreMessage(`Could not start second innings: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Create one innings of a Super Over.
  const createSuperOverInnings = async ({
    number,
    inningsNumber,
    battingId,
    bowlingId,
    targetValue = 0
  }) => {
    const nextNumber = inningsHistory.length
      ? Math.max(...inningsHistory.map(i => Number(i.innings_number))) + 1
      : innings + 1

    const { data, error } = await supabase
      .from('innings')
      .insert({
        match_id: matchId,
        innings_number: nextNumber,
        batting_team_id: battingId,
        bowling_team_id: bowlingId,
        match_overs: Math.ceil(Number(superOverBalls) / 6),
        max_wickets: Number(superOverWickets),
        total_runs: 0,
        wickets: 0,
        legal_balls: 0,
        striker_name: 'Batter 1',
        non_striker_name: 'Batter 2',
        current_bowler_name: 'Bowler 1',
        target: targetValue || null,
        status: 'in_progress',
        innings_type: 'SUPER_OVER',
        super_over_number: number,
        super_over_innings: inningsNumber
      })
      .select('*')
      .single()

    if (error) throw error

    setInningsId(data.id)
    setInnings(nextNumber)
    setInningsType('SUPER_OVER')
    setSuperOverNumber(number)
    setSuperOverInnings(inningsNumber)
    setBattingFirst(battingId === teamAId ? 'A' : 'B')
    setTarget(targetValue)
    setInningsBallLimit(Number(superOverBalls))
    setInningsMaxWickets(Number(superOverWickets))
    setRuns(0)
    setWickets(0)
    setBalls(0)
    setEvents([])
    setAdjustments([])
    setFreeHitNext(false)
    setStrikerName('Batter 1')
    setNonStrikerName('Batter 2')
    setBowlerName('Bowler 1')
    setInningsStatus('in_progress')
    setInningsHistory(prev => [...prev, data])

    return data
  }

  // Start first Super Over after main match tie.
  const startSuperOver = async () => {
    if (
      !canManage ||
      innings !== 2 ||
      !inningsComplete ||
      runs !== target - 1
    ) {
      setScoreMessage('A tied main match is required to start a Super Over.')
      return
    }

    setBusy(true)

    try {
      const { data: mainInnings, error } = await supabase
        .from('innings')
        .select('*')
        .eq('match_id', matchId)
        .eq('innings_type', 'MAIN')
        .order('innings_number', { ascending: true })

      if (error) throw error

      const first = mainInnings.find(i => i.innings_number === 1)
      const second = mainInnings.find(i => i.innings_number === 2)

      if (!first || !second) {
        throw new Error('Main innings scorecards are missing.')
      }

      const firstBattingId = first.batting_team_id
      const secondBattingId = second.batting_team_id

      await supabase
        .from('innings')
        .update({ status: 'completed' })
        .eq('id', inningsId)

      const { error: matchError } = await supabase
        .from('matches')
        .update({
          is_super_over_active: true,
          super_over_count: 1
        })
        .eq('id', matchId)

      if (matchError) throw matchError

      setMainFirstRuns(Number(first.total_runs || 0))
      setSuperFirstRuns(null)

      // Team that batted second in the main match bats first.
      await createSuperOverInnings({
        number: 1,
        inningsNumber: 1,
        battingId: secondBattingId,
        bowlingId: firstBattingId
      })

      setScoreMessage('Super Over 1 started.')
    } catch (error) {
      setScoreMessage(`Could not start Super Over: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Start second innings of a Super Over.
  const startSecondSuperOverInnings = async () => {
    if (
      !inningsComplete ||
      inningsType !== 'SUPER_OVER' ||
      superOverInnings !== 1
    ) {
      setScoreMessage('Complete the first Super Over innings first.')
      return
    }

    setBusy(true)

    try {
      const current = await supabase
        .from('innings')
        .select('*')
        .eq('id', inningsId)
        .single()

      if (current.error) throw current.error

      const firstRuns = Number(current.data.total_runs || 0)
      setSuperFirstRuns(firstRuns)

      const { error: completeError } = await supabase
        .from('innings')
        .update({ status: 'completed' })
        .eq('id', inningsId)

      if (completeError) throw completeError

      await createSuperOverInnings({
        number: superOverNumber,
        inningsNumber: 2,
        battingId: current.data.bowling_team_id,
        bowlingId: current.data.batting_team_id,
        targetValue: firstRuns + 1
      })

      setScoreMessage(
        `Super Over ${superOverNumber} second innings started. Target: ${firstRuns + 1}.`
      )
    } catch (error) {
      setScoreMessage(`Could not start second Super Over innings: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Finish a Super Over pair or start another if tied.
  const finishSuperOver = async () => {
    if (
      !inningsComplete ||
      inningsType !== 'SUPER_OVER' ||
      superOverInnings !== 2
    ) {
      setScoreMessage('Complete the second Super Over innings first.')
      return
    }

    setBusy(true)

    try {
      const current = await supabase
        .from('innings')
        .select('*')
        .eq('id', inningsId)
        .single()

      if (current.error) throw current.error

      const secondRuns = Number(current.data.total_runs || 0)

      const { data: firstSuperInnings, error: firstSuperError } =
        await supabase
          .from('innings')
          .select('total_runs')
          .eq('match_id', matchId)
          .eq('innings_type', 'SUPER_OVER')
          .eq('super_over_number', superOverNumber)
          .eq('super_over_innings', 1)
          .single()

      if (firstSuperError) throw firstSuperError

      const firstRuns = Number(firstSuperInnings.total_runs || 0)

      const { error: completeSecondError } = await supabase
        .from('innings')
        .update({ status: 'completed' })
        .eq('id', inningsId)

      if (completeSecondError) throw completeSecondError

      if (secondRuns === firstRuns) {
        const nextNumber = superOverNumber + 1

        const { data: previousPair, error: pairError } =
          await supabase
            .from('innings')
            .select('*')
            .eq('match_id', matchId)
            .eq('innings_type', 'SUPER_OVER')
            .eq('super_over_number', superOverNumber)

        if (pairError) throw pairError

        const previousFirst = previousPair?.find(
          i => Number(i.super_over_innings) === 1
        )

        const previousSecond = previousPair?.find(
          i => Number(i.super_over_innings) === 2
        )

        // The team that batted second bats first in the next Super Over.
        const firstBattingId = previousSecond?.batting_team_id
        const secondBattingId = previousFirst?.batting_team_id

        if (!firstBattingId || !secondBattingId) {
          throw new Error(
            'Could not determine the next Super Over batting order.'
          )
        }

        const { error } = await supabase
          .from('matches')
          .update({ super_over_count: nextNumber })
          .eq('id', matchId)

        if (error) throw error

        setSuperFirstRuns(null)

        await createSuperOverInnings({
          number: nextNumber,
          inningsNumber: 1,
          battingId: firstBattingId,
          bowlingId: secondBattingId
        })

        setScoreMessage(
          `Super Over ${nextNumber} started because the previous Super Over was tied.`
        )

        return
      }

      const winnerId = secondRuns > firstRuns
        ? current.data.batting_team_id
        : current.data.bowling_team_id

      const winnerName = winnerId === teamAId ? teamA : teamB

      const result =
        `${winnerName} won in Super Over ${superOverNumber}`

      const { error: resultError } = await supabase
        .from('matches')
        .update({
          winner_team_id: winnerId,
          result_text: result,
          status: 'completed',
          is_super_over_active: false,
          completed_at: new Date().toISOString()
        })
        .eq('id', matchId)

      if (resultError) throw resultError

      setSavedResult(result)
      setResultText(result)
      setMatchStatus('completed')
      setMatchStarted(false)
      setScoreMessage(`Match completed. ${result}.`)
    } catch (error) {
      setScoreMessage(`Could not finish Super Over: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Final main match result.
  const finishMatch = async () => {
    if (
      !canManage ||
      !matchId ||
      innings !== 2 ||
      inningsType !== 'MAIN' ||
      !inningsComplete
    ) {
      setScoreMessage('Complete the second main innings first.')
      return
    }

    if (runs === target - 1) {
      setScoreMessage(
        'Match tied. Start a Super Over instead of declaring a winner.'
      )
      return
    }

    setBusy(true)

    try {
      const first = await supabase
        .from('innings')
        .select('*')
        .eq('match_id', matchId)
        .eq('innings_type', 'MAIN')
        .eq('innings_number', 1)
        .single()

      if (first.error) throw first.error

      const firstRuns = Number(first.data.total_runs || 0)

      const winnerId = runs >= target
        ? (battingFirst === 'A' ? teamAId : teamBId)
        : first.data.batting_team_id

      const winnerName = winnerId === teamAId ? teamA : teamB

      const result = runs >= target
        ? `${winnerName} won by ${Math.max(0, inningsMaxWickets - wickets)} wickets`
        : `${winnerName} won by ${Math.max(0, firstRuns - runs)} runs`

      const { error } = await supabase
        .from('matches')
        .update({
          winner_team_id: winnerId,
          result_text: resultText.trim() || result,
          status: 'completed',
          is_super_over_active: false,
          completed_at: new Date().toISOString()
        })
        .eq('id', matchId)

      if (error) throw error

      const { error: inningsUpdateError } = await supabase
        .from('innings')
        .update({ status: 'completed' })
        .eq('id', inningsId)

      if (inningsUpdateError) throw inningsUpdateError

      setSavedResult(resultText.trim() || result)
      setMatchStatus('completed')
      setMatchStarted(false)
      setScoreMessage('Final match result saved.')
    } catch (error) {
      setScoreMessage(`Could not save result: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  // Save YouTube or VDO.Ninja URL.
  const saveStreamLink = async () => {
    const url = getEmbedUrl(streamLinkInput)

    if (!url) {
      setStreamMessage('Enter a valid YouTube or VDO.Ninja link.')
      return
    }

    setBusy(true)

    try {
      if (matchId && isAdministrator) {
        const { error: deactivateError } = await supabase
          .from('stream_links')
          .update({ is_active: false })
          .eq('match_id', matchId)

        if (deactivateError) throw deactivateError

        const { error: insertError } = await supabase
          .from('stream_links')
          .insert({
            match_id: matchId,
            stream_url: streamLinkInput.trim(),
            is_active: true
          })

        if (insertError) throw insertError
      } else if (matchId && !isAdministrator) {
        throw new Error('Only an administrator can update the live stream link.')
      }

      setCameraLink(url)
      setStreamMessage('Stream link detected and updated successfully.')
    } catch (error) {
      setStreamMessage(`Stream update failed: ${error.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="website">
      <header className="navbar">
        <div className="brand">
          <div className="brand-icon">🏏</div>
          <div>
            <h2>CRICKET<span>LIVE</span></h2>
            <small>ASSOCIATION BROADCAST</small>
          </div>
        </div>

        <div className="nav-status">
          <span className="status-dot" /> LIVE MATCH CENTER
          {!canManage && <a className="staff-login-link" href={`${window.location.pathname}?login=1`}>STAFF LOGIN</a>}
        </div>
      </header>

      <main>
        <section className="welcome">
          <div className="eyebrow">THE GAME. THE MOMENT. LIVE.</div>
          <h1>Experience Cricket <span>Live.</span></h1>
          <p>Watch every boundary, wicket and winning moment, right here.</p>
        </section>

        <section className="stream-section">
          <div className="stream-heading">
            <div>
              <div className="live-label">
                <span className="status-dot" /> MOBILE CAMERA BROADCAST
              </div>
              <h2>Live Match Broadcast</h2>
            </div>

            <span className="public-tag">LIVE STREAM</span>
          </div>

          <div className="video-container">
            {embedUrl ? (
              <iframe
                src={embedUrl}
                title="Live Cricket Broadcast"
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
              />
            ) : (
              <div className="match-message">
                No valid stream link configured.
              </div>
            )}
            <BroadcastScoreOverlay matchId={matchId} />
          </div>
        </section>

        <section className="scoreboard">
          <div className="score-top">
            <div>
              <span className="score-live">
                ● {matchStatus === 'completed'
                  ? 'MATCH COMPLETED'
                  : 'LIVE SCORE'}
              </span>

              <h2>{battingTeam}</h2>

              <p>
                {inningsType === 'SUPER_OVER'
                  ? `SUPER OVER ${superOverNumber} · INNINGS ${superOverInnings}`
                  : `Innings ${innings} · ${matchOvers} Overs Match`}
              </p>
            </div>

            <div className="score-main">
              <strong>{runs}/{wickets}</strong>
              <span>{overs} Overs</span>
            </div>
          </div>

          <div className="score-stats">
            <div>
              <small>RUN RATE</small>
              <strong>{runRate}</strong>
            </div>

            <div>
              <small>EXTRAS</small>
              <strong>{currentExtras}</strong>
            </div>

            <div>
              <small>OVERS LEFT</small>
              <strong>
                {Math.max(0, (totalBalls - balls) / 6).toFixed(1)}
              </strong>
            </div>
          </div>

          {target > 0 && (
            <div className="match-message">
              Target: {target} · Need {Math.max(0, target - runs)} runs
            </div>
          )}

          {freeHitNext && (
            <div className="match-message">
              FREE HIT NEXT DELIVERY
            </div>
          )}

          <div className="score-divider" />

          <div className="score-columns">
            <div>
              <h3>BATTERS</h3>

              <div className="score-table-heading">
                <span>PLAYER</span>
                <span>R</span>
                <span>B</span>
                <span>4s</span>
                <span>6s</span>
              </div>

              {currentBatters.map((batter, index) => (
                <div
                  className="score-table-row"
                  key={`${batter.name}-${index}`}
                >
                  <span>
                    {batter.name}
                    {batter.name === strikerName ? '*' : ''}
                  </span>
                  <span>{batter.runs}</span>
                  <span>{batter.balls}</span>
                  <span>{batter.fours}</span>
                  <span>{batter.sixes}</span>
                </div>
              ))}
            </div>

            <div>
              <h3>BOWLER</h3>

              <div className="score-table-heading">
                <span>PLAYER</span>
                <span>O</span>
                <span>R</span>
                <span>W</span>
              </div>

              <div className="score-table-row">
                <span>{bowlerName}</span>
                <span>
                  {Math.floor(currentBowlerStats.balls / 6)}.
                  {currentBowlerStats.balls % 6}
                </span>
                <span>{currentBowlerStats.runs}</span>
                <span>{currentBowlerStats.wickets}</span>
              </div>
            </div>
          </div>

          <div className="last-balls">
            <h3>CURRENT OVER · OVER {Math.floor(balls / 6) + 1}</h3>

            <div className="ball-list">
              {currentOverEvents.length
                ? currentOverEvents.map((ball, index) => (
                    <span
                      className="ball"
                      key={ball.id || index}
                    >
                      {formatBall(ball)}
                    </span>
                  ))
                : (
                  <span className="no-balls">
                    No delivery in this over yet
                  </span>
                )}
            </div>
          </div>

          <div className="last-balls">
            <h3>LAST SIX LEGAL BALLS</h3>

            <div className="ball-list">
              {currentLastBalls.length
                ? currentLastBalls.map((ball, index) => (
                    <span className="ball" key={index}>
                      {ball}
                    </span>
                  ))
                : (
                  <span className="no-balls">
                    No balls recorded yet
                  </span>
                )}
            </div>
          </div>

          {savedResult && (
            <div className="match-message">
              <strong>FINAL RESULT: </strong>
              {savedResult}
            </div>
          )}
        </section>

        {inningsHistory.length > 0 && (
          <section className="scoreboard">
            <div className="stream-heading">
              <div>
                <div className="live-label">MATCH RECORD</div>
                <h2>Innings & Super Over Scorecards</h2>
              </div>
            </div>

            {inningsHistory.map(row => {
              const teamName =
                row.batting_team_id === teamAId ? teamA : teamB

              const isSuper = row.innings_type === 'SUPER_OVER'

              return (
                <div className="score-table-row" key={row.id}>
                  <span>
                    {isSuper
                      ? `Super Over ${row.super_over_number} · Innings ${row.super_over_innings}`
                      : `Main Innings ${row.innings_number}`}
                    {' · '}{teamName}
                  </span>

                  <span>
                    {Number(row.total_runs || 0)}/
                    {Number(row.wickets || 0)}
                  </span>

                  <span>
                    {Math.floor(Number(row.legal_balls || 0) / 6)}.
                    {Number(row.legal_balls || 0) % 6} ov
                  </span>

                  <span>
                    {row.status === 'completed'
                      ? 'Completed'
                      : 'In progress'}
                  </span>
                </div>
              )
            })}
          </section>
        )}

        {(isLoginPage || canManage) && (
        <section className="scorer-panel">
          <div className="scorer-heading">
            <div>
              <span className="eyebrow">MATCH MANAGEMENT</span>
              <h2>Scorer Control Panel</h2>
            </div>

            <span className="admin-tag">
              {authLoading ? 'CHECKING ACCESS' : isAdministrator ? 'ADMINISTRATOR' : canManage ? 'AUTHORIZED SCORER' : 'STAFF LOGIN'}
            </span>
          </div>

          {!canManage ? (
            <form
              className="player-management"
              onSubmit={signIn}
            >
              <div>
                <h3>STAFF SIGN IN</h3>
                <p>Administrator and scorer accounts only. Public registration is disabled.</p>

                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="Scorer email"
                  required
                />

                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Password"
                  required
                />

                <button type="submit" disabled={busy}>
                  Sign in
                </button>

                {authMessage && <p>{authMessage}</p>}
              </div>
            </form>
          ) : (
            <div className="scorer-actions">
              <span>Signed in: {session.user.email} · {userRole}</span>
              <button onClick={signOut}>Sign out</button>
            </div>
          )}

          {canManage && <>
          {isAdministrator && (
            <section className="admin-account-manager">
              <h3 className="control-title">ADMINISTRATOR · STAFF ACCOUNTS</h3>
              <form className="player-management" onSubmit={createStaffAccount}>
                <div>
                  <label>New account email
                    <input type="email" value={newStaffEmail} onChange={event => setNewStaffEmail(event.target.value)} placeholder="scorer@example.com" required />
                  </label>
                  <label>Temporary password (minimum 8 characters)
                    <input type="password" value={newStaffPassword} onChange={event => setNewStaffPassword(event.target.value)} minLength={8} autoComplete="new-password" required />
                  </label>
                  <label>Account role
                    <select value={newStaffRole} onChange={event => setNewStaffRole(event.target.value)}>
                      <option value="scorer">Scorer</option>
                      <option value="administrator">Administrator</option>
                    </select>
                  </label>
                  <button type="submit" disabled={busy}>Create Authorized Account</button>
                </div>
              </form>

              <div className="admin-account-list">
                <h4>Registered accounts</h4>
                {staffAccounts.map(account => (
                  <div className="admin-account-row" key={account.id}>
                    <span>{account.email || 'No email'}{account.id === session?.user?.id ? ' (you)' : ''}</span>
                    <select
                      aria-label={`Role for ${account.email || 'account'}`}
                      value={account.role}
                      disabled={busy || account.id === session?.user?.id}
                      onChange={event => updateStaffRole(account.id, event.target.value)}
                    >
                      <option value="administrator">Administrator</option>
                      <option value="scorer">Scorer</option>
                      <option value="viewer">Viewer</option>
                    </select>
                  </div>
                ))}
                {!staffAccounts.length && <p>No accounts found.</p>}
              </div>
              {accountMessage && <p className="match-message">{accountMessage}</p>}
            </section>
          )}

          <h3 className="control-title">MATCH SETUP</h3>

          <div className="scorer-match-settings">
            <label>
              Team A
              <input
                value={teamA}
                onChange={e => setTeamA(e.target.value)}
                disabled={matchStarted}
              />
            </label>

            <label>
              Team B
              <input
                value={teamB}
                onChange={e => setTeamB(e.target.value)}
                disabled={matchStarted}
              />
            </label>

            <label>
              Match format
              <select
                value={matchFormat}
                onChange={e => setMatchFormat(e.target.value)}
                disabled={matchStarted}
              >
                <option value="T10">T10</option>
                <option value="T20">T20</option>
                <option value="ODI">ODI</option>
                <option value="CUSTOM">Custom Overs</option>
              </select>
            </label>

            {matchFormat === 'CUSTOM' && (
              <label>
                Custom overs
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={customOvers}
                  onChange={e =>
                    setCustomOvers(
                      Math.max(1, Number(e.target.value) || 1)
                    )
                  }
                  disabled={matchStarted}
                />
              </label>
            )}

            <label>
              Batting first
              <select
                value={battingFirst}
                onChange={e => setBattingFirst(e.target.value)}
                disabled={matchStarted}
              >
                <option value="A">Team A</option>
                <option value="B">Team B</option>
              </select>
            </label>

            <label>
              Wicket limit per innings
              <select
                value={maxWickets}
                onChange={e => setMaxWickets(Number(e.target.value))}
                disabled={matchStarted}
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                  <option key={n} value={n}>
                    {n} wickets
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h3 className="control-title">SUPER OVER SETTINGS</h3>

          <div className="player-management">
            <div>
              <label>
                Super Over legal balls
                <input
                  type="number"
                  min="1"
                  max="36"
                  value={superOverBalls}
                  onChange={e =>
                    setSuperOverBalls(
                      Math.max(
                        1,
                        Math.min(36, Number(e.target.value) || 1)
                      )
                    )
                  }
                  disabled={matchStarted}
                />
              </label>
            </div>

            <div>
              <label>
                Maximum wickets
                <select
                  value={superOverWickets}
                  onChange={e =>
                    setSuperOverWickets(Number(e.target.value))
                  }
                  disabled={matchStarted}
                >
                  {[1, 2, 3, 4, 5, 6, 10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="scorer-current">
            <span>RECORD NEXT DELIVERY</span>
            <strong>{battingTeam} batting</strong>
            <small>{overs} overs · {runs}/{wickets}</small>
          </div>

          <h3 className="control-title">EDIT PLAYER NAMES</h3>

          <div className="player-management">
            <div>
              <label>
                Striker name
                <input
                  value={strikerName}
                  onChange={e => setStrikerName(e.target.value)}
                  disabled={!matchStarted}
                />
              </label>
            </div>

            <div>
              <label>
                Non-striker name
                <input
                  value={nonStrikerName}
                  onChange={e => setNonStrikerName(e.target.value)}
                  disabled={!matchStarted}
                />
              </label>
            </div>

            <div>
              <label>
                Bowler name
                <input
                  value={newBowler || bowlerName}
                  onChange={e => setNewBowler(e.target.value)}
                  disabled={!matchStarted}
                />
              </label>

              <button
                onClick={() => {
                  if (newBowler.trim()) {
                    savePlayerNames(
                      strikerName,
                      nonStrikerName,
                      newBowler.trim()
                    )
                    setNewBowler('')
                  }
                }}
                disabled={!canManage || busy}
              >
                Save bowler
              </button>
            </div>

            <div>
              <button
                onClick={() => savePlayerNames()}
                disabled={!canManage || busy}
              >
                Save batter names
              </button>
            </div>
          </div>

          <div className="scoring-workspace-grid">
            <div className="scoring-workspace-card add-runs-card">
              <h3 className="control-title">ADD RUNS</h3>

              <div className="scoring-buttons">
                {[0, 1, 2, 3, 4, 6].map(n => (
                  <button
                    key={n}
                    onClick={() => addRuns(n)}
                    disabled={!canScore || inningsComplete}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="scoring-workspace-card scoring-correction-card">
              <h3 className="control-title">SCORING CORRECTION</h3>

              <div className="scoring-buttons extra-buttons">
                <button
                  onClick={undoLastDelivery}
                  disabled={!canManage || busy || !events.length}
                >
                  UNDO LAST DELIVERY
                </button>

                <button
                  onClick={undoPenalty}
                  disabled={!canManage || busy || !adjustments.length}
                >
                  UNDO LAST PENALTY
                </button>

                <button
                  onClick={undoPlayerChange}
                  disabled={!canManage || busy}
                >
                  UNDO PLAYER CHANGE
                </button>
              </div>
            </div>
          </div>

          <h3 className="control-title">WIDE RUNS</h3>

          <div className="player-management">
            <div>
              <label>
                Additional wide runs
                <select
                  value={wideAdditional}
                  onChange={e =>
                    setWideAdditional(Number(e.target.value))
                  }
                >
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => (
                    <option key={n} value={n}>
                      {n} additional · {n + 1} total
                    </option>
                  ))}
                </select>
              </label>

              <button
                onClick={addWide}
                disabled={!canScore || inningsComplete}
              >
                Record Wide
              </button>
            </div>
          </div>

          <h3 className="control-title">NO-BALL RUNS</h3>

          <div className="player-management">
            <div>
              <label>
                Run type on no-ball
                <select
                  value={noBallRunType}
                  onChange={e => setNoBallRunType(e.target.value)}
                >
                  <option value="bat">Runs off the bat</option>
                  <option value="bye">Byes</option>
                  <option value="leg_bye">Leg-byes</option>
                </select>
              </label>
            </div>

            <div>
              <label>
                {noBallRunType === 'bat'
                  ? 'Batter runs'
                  : noBallRunType === 'bye'
                    ? 'Bye runs'
                    : 'Leg-bye runs'}

                <select
                  value={noBallBatRuns}
                  onChange={e =>
                    setNoBallBatRuns(Number(e.target.value))
                  }
                >
                  {[0, 1, 2, 3, 4, 5, 6].map(n => (
                    <option key={n} value={n}>
                      {n} {
                        noBallRunType === 'bat'
                          ? 'batter runs'
                          : noBallRunType === 'bye'
                            ? 'bye runs'
                            : 'leg-bye runs'
                      } + 1 no-ball
                    </option>
                  ))}
                </select>
              </label>

              <button
                onClick={addNoBall}
                disabled={!canScore || inningsComplete}
              >
                Record No-Ball
              </button>
            </div>
          </div>

          <h3 className="control-title">BYE / LEG-BYE</h3>

          <div className="player-management">
            <div>
              <label>
                Bye runs
                <select
                  value={byeRuns}
                  onChange={e => setByeRuns(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5, 6].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>

              <button
                onClick={() => addBye('bye', byeRuns)}
                disabled={!canScore || inningsComplete}
              >
                Record Bye
              </button>
            </div>

            <div>
              <label>
                Leg-bye runs
                <select
                  value={legByeRuns}
                  onChange={e => setLegByeRuns(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5, 6].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>

              <button
                onClick={() => addBye('leg_bye', legByeRuns)}
                disabled={!canScore || inningsComplete}
              >
                Record Leg-bye
              </button>
            </div>
          </div>

          <h3 className="control-title">PENALTY RUNS</h3>

          <div className="player-management">
            <div>
              <label>
                Penalty runs
                <select
                  value={penaltyRuns}
                  onChange={e =>
                    setPenaltyRuns(Number(e.target.value))
                  }
                >
                  {[1, 2, 3, 4, 5, 6].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <label>
                Team awarded
                <select
                  value={penaltyTeam}
                  onChange={e => setPenaltyTeam(e.target.value)}
                >
                  <option value="batting">Batting team</option>
                  <option value="bowling">Bowling team</option>
                </select>
              </label>
            </div>

            <div>
              <label>
                Reason
                <input
                  value={penaltyReason}
                  onChange={e => setPenaltyReason(e.target.value)}
                  placeholder="Reason for penalty"
                />
              </label>

              <button
                onClick={addPenalty}
                disabled={!canScore}
              >
                Record Penalty
              </button>
            </div>
          </div>

          <h3 className="control-title">RECORD WICKET</h3>

          <div className="player-management">
            <div>
              <label>
                Dismissal type
                <select
                  value={dismissalType}
                  onChange={e => setDismissalType(e.target.value)}
                >
                  {DISMISSALS.map(type => (
                    <option key={type} value={type}>
                      {type.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div>
              <label>
                Dismissed player
                <select
                  value={dismissedPlayer}
                  onChange={e => setDismissedPlayer(e.target.value)}
                >
                  <option value="striker">{strikerName}</option>
                  <option value="non_striker">{nonStrikerName}</option>
                </select>
              </label>
            </div>

            <div>
              <label>
                Fielder name (if applicable)
                <input
                  value={fielderName}
                  onChange={e => setFielderName(e.target.value)}
                  placeholder="Fielder name"
                />
              </label>
            </div>

            {dismissalType === 'run out' && (
              <>
                <div>
                  <label>
                    Completed runs
                    <select
                      value={runOutRuns}
                      onChange={e =>
                        setRunOutRuns(Number(e.target.value))
                      }
                    >
                      {[0, 1, 2, 3, 4, 5].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                </div>

                <div>
                  <label>
                    Did batters cross before wicket was broken?
                    <select
                      value={String(runOutCrossed)}
                      onChange={e =>
                        setRunOutCrossed(e.target.value === 'true')
                      }
                    >
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </label>
                </div>
              </>
            )}

            <div>
              <label>
                Next batter name
                <input
                  value={newBatter}
                  onChange={e => setNewBatter(e.target.value)}
                  placeholder="Enter next batter name"
                />
              </label>
            </div>

            <div>
              <button
                className="wicket-button"
                onClick={addWicket}
                disabled={
                  !canScore ||
                  inningsComplete ||
                  wickets >= inningsMaxWickets
                }
              >
                RECORD WICKET
              </button>
            </div>
          </div>

          <h3 className="control-title">MATCH CONTROL</h3>

          <div className="scorer-actions">
            <button
              onClick={startMatch}
              disabled={!canManage || busy || matchStarted}
            >
              Start New Match
            </button>
          </div>

          {inningsType === 'MAIN' &&
            innings === 1 &&
            inningsComplete &&
            matchStarted && (
              <div className="player-management">
                <div>
                  <h3>FIRST INNINGS COMPLETED</h3>
                  <p>First innings score: {runs}/{wickets}</p>

                  <button
                    onClick={startSecondInnings}
                    disabled={!canManage || busy}
                  >
                    Start Second Innings
                  </button>
                </div>
              </div>
            )}

          {inningsType === 'MAIN' &&
            innings === 2 &&
            inningsComplete &&
            runs === target - 1 &&
            matchStarted && (
              <div className="player-management">
                <div>
                  <h3>MATCH TIED</h3>
                  <p>Start a Super Over to decide the winner.</p>

                  <button
                    onClick={startSuperOver}
                    disabled={!canManage || busy}
                  >
                    START SUPER OVER
                  </button>
                </div>
              </div>
            )}

          {inningsType === 'SUPER_OVER' &&
            superOverInnings === 1 &&
            inningsComplete &&
            matchStarted && (
              <div className="player-management">
                <div>
                  <h3>
                    SUPER OVER {superOverNumber} - FIRST INNINGS COMPLETED
                  </h3>

                  <button
                    onClick={startSecondSuperOverInnings}
                    disabled={!canManage || busy}
                  >
                    START SECOND SUPER OVER INNINGS
                  </button>
                </div>
              </div>
            )}

          {inningsType === 'SUPER_OVER' &&
            superOverInnings === 2 &&
            inningsComplete &&
            matchStarted && (
              <div className="player-management">
                <div>
                  <h3>SUPER OVER {superOverNumber} COMPLETED</h3>
                  <p>Compare the two Super Over scores.</p>

                  <button
                    onClick={finishSuperOver}
                    disabled={!canManage || busy}
                  >
                    FINISH / NEXT SUPER OVER
                  </button>
                </div>
              </div>
            )}

          <h3 className="control-title">SAVE FINAL MATCH RESULT</h3>

          <div className="player-management">
            <div>
              <label>
                Result description
                <input
                  value={resultText}
                  onChange={e => setResultText(e.target.value)}
                  placeholder="Optional result description"
                />
              </label>

              <button
                onClick={finishMatch}
                disabled={
                  !canManage ||
                  busy ||
                  Boolean(savedResult) ||
                  inningsType !== 'MAIN' ||
                  innings !== 2 ||
                  !inningsComplete ||
                  runs === target - 1
                }
              >
                Finish Match & Save Result
              </button>
            </div>
          </div>

          {scoreMessage && (
            <p className="match-message">{scoreMessage}</p>
          )}
          </>}
        </section>
        )}

        <section className="features">
          <div className="feature-card">
            <span>📺</span>
            <h3>Live Broadcast</h3>
            <p>Watch the match directly on this website.</p>
          </div>

          <div className="feature-card">
            <span>🏏</span>
            <h3>Live Score</h3>
            <p>Follow runs, wickets and player statistics.</p>
          </div>

          <div className="feature-card">
            <span>📱</span>
            <h3>Any Device</h3>
            <p>Access the match on mobile, tablet or laptop.</p>
          </div>
        </section>

        {isAdministrator && (
        <section className="stream-link-admin">
          <div className="stream-link-admin-heading">
            <span className="eyebrow">ADMINISTRATION</span>
            <h2>Update Live Stream Link</h2>
            <p>
              Paste a YouTube video, Shorts, Live, youtu.be or VDO.Ninja link.
              The website detects the platform automatically.
            </p>
          </div>

          <div className="stream-link-form">
            <label htmlFor="stream-link-input">
              Live stream URL
            </label>

            <input
              id="stream-link-input"
              type="url"
              value={streamLinkInput}
              onChange={e => setStreamLinkInput(e.target.value)}
              placeholder="Paste YouTube / Shorts / Live / VDO.Ninja link"
            />

            <button
              type="button"
              onClick={saveStreamLink}
              disabled={busy}
            >
              Save Stream Link
            </button>
          </div>

          <div className="obs-overlay-instructions">
            <label htmlFor="obs-overlay-url">OBS / BROADCAST SCOREBOARD URL</label>
            <input id="obs-overlay-url" type="text" readOnly value={obsOverlayUrl} onFocus={event => event.target.select()} />
            <p>Copy this URL into OBS → Sources → + → Browser. Set the source width to 1920 and height to 1080. Keep the background transparent.</p>
          </div>

          {streamMessage && (
            <p className="stream-link-message">{streamMessage}</p>
          )}

          <small className="stream-link-note">
            Saving a stream link requires scorer sign-in and an active match.
          </small>
        </section>
        )}
      </main>

      <footer>
        <div className="brand footer-brand">
          <div className="brand-icon">🏏</div>
          <h2>CRICKET<span>LIVE</span></h2>
        </div>

        <p>
          Bringing the cricket community closer, one match at a time.
        </p>

        <small>
          © 2026 Cricket Association. All rights reserved.
        </small>
      </footer>
    </div>
  )
}

function App() {
  const params = new URLSearchParams(window.location.search)
  const isOverlay = params.get('overlay') === '1'
  const requestedMatchId = params.get('match') || null

  if (isOverlay) {
    return <BroadcastScoreOverlay matchId={requestedMatchId} obsMode />
  }

  return <MainWebsite />
}

export default App