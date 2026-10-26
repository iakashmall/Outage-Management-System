import { useEffect, useState, useCallback, useMemo, useRef, Component } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Network from 'expo-network';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDiscovery,
  redirectUri,
  login,
  restoreSession,
  logout as authLogout,
  isAuthenticated,
  myCrewId,
  isBiometricEnabled,
  setBiometricEnabled,
} from './lib/auth';
import { biometricUnlock } from './lib/biometric';
import { getLockoutStatus, recordFailedAttempt, resetAttempts as resetLoginAttempts, MAX_ATTEMPTS, LOCKOUT_MS } from './lib/lockout';
import { API_PORT, CLIENT_ID, KEYCLOAK_PORT, JOB_POLL_INTERVAL_MS } from './config';
import { reportTrackingState, getCurrentCrew, fetchMyJobs, clearJobCache, updateJobStatus, getJobMessages, getJobPhotos, getCrewMessages, saveAssetScan, getAssetScans, isNotYourJob, postJobCompletion, postJobChecklist, reopenJob, getWorkOrder, startWorkOrder, closeWorkOrder, sendJobMessage, requestReassignment, getReassignRequest, reportJobSeen } from './lib/api.js';
import { getLocation } from './lib/location';
import { uploadCapturedPhoto } from './lib/photos';
import { siteBlock, SITE_STATUSES } from './lib/siteCheck';
import { setupAlerts, findNewJobs, findNewMessages, alertNewJobs, alertNewMessages, reportDelivered, isOwnMessage } from './lib/alerts';
import { queueUpdate, queueScan, queueCompletion, queueChecklist, queueWorkOrder, keepUndeliveredCompletion, getUndeliveredCompletion, clearUndeliveredCompletion, isRetryable, isRefusal, flushQueue, getQueueLength, getQueueItems } from './lib/offlineQueue';
import { localDate, workOrderId, viewWorkOrder, dayJobs, summarize, startPayload, closePayload, cleanMembers } from './lib/workOrder';
import { getCachedWorkOrder, cacheWorkOrder, getPendingWorkOrder, setPendingWorkOrder, getLastMembers, saveLastMembers, clearWorkOrderCache } from './lib/workOrderStore';
import DailyWorkOrder from './components/DailyWorkOrder';
import { SUBMITTED_LABEL, RESTORED_CHOICES, isCompleted, canSendCompletion, canResendCompletion, canReopen, isReadOnly, completionPayload, serverJobUpdate } from './lib/jobFlow';
import { startCrewTracking, stopCrewTracking, autoStartCrewTracking, setTrackingPausedByCrew, isLocationServiceOn } from './lib/backgroundLocation';
import { flushLocations, getPendingLocationCount } from './lib/locationQueue';
import { downloadPack } from './lib/offlineMap/areaStore';
import CrewMap from './components/CrewMap';
import { usingMapTestServer } from './lib/mapServer';
import { checkServer, getServer, setServer } from './lib/server';
import SafetyChecklist from './components/SafetyChecklist';
import QrScanner from './components/QrScanner';
import * as PriorityChecklistModule from './components/PriorityChecklist';
const PriorityChecklist = PriorityChecklistModule.default || PriorityChecklistModule;
import FaultDiagnosisWizard from './components/FaultDiagnosisWizard';
import PartsPicker from './components/PartsPicker';
import CrewLeadSignOff from './components/CrewLeadSignOff';
import PlannedOutagePanel from './components/PlannedOutagePanel';
import { getPlannedOutage, updatePlannedJobStatus } from './lib/api.js';
import { gateFor } from './lib/plannedOutage';

WebBrowser.maybeCompleteAuthSession();

const FALLBACK_JOBS = [
  { id: 'JOB-1005', title: 'Pending Line Inspection', address: 'Mussoorie Road, Dehradun', coordinates: { lat: 30.3606, lon: 78.0647 }, severity: 'High', status: 'Pending Acceptance', customers: 386, distance: '1.6 km' },
  { id: 'JOB-1001', title: 'Transformer Failure', address: 'Rajpur Road, Dehradun', coordinates: { lat: 30.3476, lon: 78.0808 }, severity: 'Critical', status: 'Acknowledged', customers: 842, distance: '2.4 km' },
  { id: 'JOB-1002', title: 'Line Fault', address: 'Haridwar Road, Rishikesh', coordinates: { lat: 30.3136, lon: 78.0322 }, severity: 'High', status: 'En Route', customers: 531, distance: '5.8 km' },
];

const NEXT_STATUS = {
  'Pending Acceptance': 'Acknowledged',
  Acknowledged: 'En Route',
  'En Route': 'On Site',
  'On Site': 'Work Started',
  'Work Started': 'Work Finished',
  'Work Finished': null,
  'Work Complete': null,
  // OMS-03: returned for correction by the control room; the crew starts again.
  'Requires Revisit': 'En Route',
};

// The app's last step is 'Work Finished'; the server stores it as
// 'Work Complete', and dashboard-closed jobs come back Completed/Closed.
const DONE_STATUSES = ['work finished', 'work complete', 'completed', 'closed'];
const isJobDone = (job) => DONE_STATUSES.includes(String(job.status).toLowerCase());

// Jobs the control room cancelled: listed under Pending Sync until the crew
// dismisses them (ids kept on the phone), never under My Jobs.
const DISMISSED_CANCELLED_KEY = 'oms-dismissed-cancelled';
// When the crew last opened the Messages screen (for the unread count).
const MESSAGES_READ_KEY = 'oms-messages-read-at';
const MESSAGE_POLL_MS = 5000;
const GLIMPSE_MS = 8000;

// Which watermark a photo gets: before work starts it is the "work started"
// photo, from then on the "work finished" one.
const photoStage = (job) => (['Work Started', 'Work Finished', 'Work Complete'].includes(job.status) ? 'work_finished' : 'work_started');
const PHOTO_STAGE_LABEL = { work_started: 'Work started photo', work_finished: 'Work finished photo' };
const fmtLatLon = (loc) => (Number.isFinite(loc?.lat) && Number.isFinite(loc?.lon) ? `${loc.lat.toFixed(6)}, ${loc.lon.toFixed(6)}` : null);

// Fault diagnosis answer, with the typed reason when "Other" was picked.
const diagText = (diagnosis, key) => (diagnosis?.[key] === 'Other' && diagnosis[`${key}Other`] ? `Other: ${diagnosis[`${key}Other`]}` : diagnosis?.[key]);

// Pending = still to do, so Total = Pending + Done.
const JOB_FILTERS = {
  all: { section: 'ALL JOBS', empty: 'No jobs assigned.', test: () => true },
  pending: { section: 'PENDING JOBS', empty: 'No pending jobs.', test: (job) => !isJobDone(job) },
  done: { section: 'JOBS DONE', empty: 'No jobs done yet.', test: isJobDone },
};

// Severity color coding: High -> orange, Medium -> blue, Low -> green,
// Critical -> red. Kept local (not imported) so this file can never crash
// due to a missing/misnamed export in another file.
const severityColors = { Critical: '#d7382a', High: '#e08a1e', Medium: '#2f6fd6', Low: '#2a9d5c' };
const MAX_JOB_PHOTOS = 25;

// The offline map pack and GPS uploads need either a real login or the
// no-auth map test server (MAP_TEST_SERVER in config.js).
const canUseMapServer = () => isAuthenticated() || usingMapTestServer;

// OMS-03 planning info from dispatch: priority and estimated duration.
function jobPlanLine(job) {
  const parts = [];
  if (job.priority) parts.push(`Priority: ${job.priority}${job.medical ? ' (Medical)' : ''}`);
  if (job.estimatedDurationMin) parts.push(`Est. ${job.estimatedDurationMin} min`);
  return parts.join(' · ');
}

// Why a status update was dropped instead of retried.
const itemLabel = (item) => (item.type === 'photo' ? `${item.id} photo` : item.type === 'scan' ? `${item.id} QR scan`
  : item.type === 'completion' ? `${item.id} completion form` : item.type === 'wo-start' ? `${item.id} start of day`
  : item.type === 'wo-close' ? `${item.id} end of day` : item.type === 'checklist' ? `${item.id} priority checklist` : `${item.id} → ${item.status}`);

function droppedUpdateNotice(item) {
  const what = itemLabel(item);
  return isNotYourJob(item)
    ? `${what} was not sent: this job was reassigned to another crew.`
    : `${what} was refused by the server: ${item.message || 'unknown reason'}`;
}

// Notices pile up (one per line) until the crew dismisses them, so a later
// one doesn't hide an earlier one they haven't read yet.
const appendNotice = (prev, msg) =>
  !msg || prev.split('\n').includes(msg) ? prev : [prev, msg].filter(Boolean).join('\n');

// Shown on the main screens and inside the job screen (a Modal covers the
// main screen), so a refusal is seen wherever the crew is.
function NoticeBanner({ notice, onDismiss }) {
  if (!notice) return null;
  return (
    <Pressable style={styles.noticeBanner} onPress={onDismiss} accessibilityLabel="Dismiss notice">
      <Text style={styles.noticeText}>{notice}</Text>
      <Text style={styles.noticeDismiss}>Tap to dismiss</Text>
    </Pressable>
  );
}

// A short heads-up at the top of the screen for a new job or a message from
// the control room (the phone notification plays the sound). Tap opens it.
function GlimpseBanner({ glimpse, onPress, onDismiss }) {
  if (!glimpse) return null;
  return (
    <Pressable style={[styles.glimpse, glimpse.kind === 'job' && styles.glimpseJob]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${glimpse.title}. ${glimpse.text}`}>
      <View style={{ flex: 1 }}>
        <Text style={styles.glimpseTitle} numberOfLines={1}>{glimpse.title}</Text>
        <Text style={styles.glimpseText} numberOfLines={2}>{glimpse.text}</Text>
      </View>
      <Pressable onPress={onDismiss} hitSlop={10} accessibilityLabel="Dismiss">
        <Text style={styles.glimpseClose}>×</Text>
      </Pressable>
    </Pressable>
  );
}

function timeAgo(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr ago`;
}

export default function NativeApp() {
  return (
    <SafeAreaProvider>
      <AppErrorBoundary>
        <NativeAppScreen />
      </AppErrorBoundary>
    </SafeAreaProvider>
  );
}

// Catches render/runtime errors anywhere below it and shows the actual
// error message on screen instead of a silent blank page — makes it much
// easier to diagnose crashes that only happen after login.
class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('NativeApp crashed:', error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={[styles.safe, styles.center, { padding: 24 }]}>
          <Text style={{ fontSize: 16, fontWeight: '800', color: '#d7382a', marginBottom: 10 }}>
            App crashed
          </Text>
          <Text style={{ fontSize: 13, color: '#33465f', textAlign: 'center' }}>
            {String(this.state.error?.message || this.state.error)}
          </Text>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

function NativeAppScreen() {
  const insets = useSafeAreaInsets();
  const [checkingSession, setCheckingSession] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [needsBiometric, setNeedsBiometric] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);
  const [biometricError, setBiometricError] = useState('');
  const [biometricOn, setBiometricOn] = useState(false);
  const [trackingOn, setTrackingOn] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const [pendingLocations, setPendingLocations] = useState(0);
  const [crew, setCrew] = useState({ name: 'Crew Gamma-2', role: 'Field Technician', id: 'C003' });
  const [jobs, setJobs] = useState(FALLBACK_JOBS);
  const [tab, setTab] = useState('Dashboard');
  const [jobFilter, setJobFilter] = useState('all');
  const [activeJob, setActiveJob] = useState(null);
  // Set by a job's "Navigate to site" ({ jobId, at }) or an asset scan's
  // "Show on map" ({ lat, lon, title, at }): the Map tab opens on it.
  // Cleared from the nav bar.
  const [mapNav, setMapNav] = useState(null);
  const [mapFocus, setMapFocus] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [pendingItems, setPendingItems] = useState([]);
  const [crewMessages, setCrewMessages] = useState([]);
  const [messagesVisible, setMessagesVisible] = useState(false);
  const [messagesReadAt, setMessagesReadAt] = useState(0);
  const [glimpse, setGlimpse] = useState(null); // { kind: 'job' | 'message', title, text, jobId }
  const [dismissedCancelled, setDismissedCancelled] = useState([]);
  // Short notice for things done to the crew's work by someone else, e.g. a
  // job reassigned to another crew (OMS-03).
  const [notice, setNotice] = useState('');
  // OMS-03 daily work order: the server's last answer and a start / end of
  // day still waiting in pending sync (see lib/workOrder.js viewWorkOrder).
  const [workDate, setWorkDate] = useState(() => localDate());
  const [workOrderServer, setWorkOrderServer] = useState(null);
  const [workOrderLocal, setWorkOrderLocal] = useState(null);
  const [lastMembers, setLastMembers] = useState([]);
  const [workOrderBusy, setWorkOrderBusy] = useState(false);
  const addNotice = useCallback((msg) => setNotice((prev) => appendNotice(prev, msg)), []);
  // Cancelled jobs leave My Jobs (and every count) for Pending Sync.
  const liveJobs = useMemo(() => jobs.filter((j) => !j.cancelled), [jobs]);
  const cancelledJobs = useMemo(() => jobs.filter((j) => j.cancelled && !dismissedCancelled.includes(j.id)), [jobs, dismissedCancelled]);
  const glimpseTimer = useRef(null);
  const showGlimpse = useCallback((g) => {
    setGlimpse(g);
    clearTimeout(glimpseTimer.current);
    glimpseTimer.current = setTimeout(() => setGlimpse(null), GLIMPSE_MS);
  }, []);
  useEffect(() => () => clearTimeout(glimpseTimer.current), []);
  useEffect(() => {
    AsyncStorage.getItem(DISMISSED_CANCELLED_KEY).then((raw) => setDismissedCancelled(raw ? JSON.parse(raw) : [])).catch(() => {});
    AsyncStorage.getItem(MESSAGES_READ_KEY).then((raw) => setMessagesReadAt(Number(raw) || 0)).catch(() => {});
  }, []);
  const dismissCancelled = useCallback((jobId) => {
    setDismissedCancelled((cur) => {
      // Only ids of jobs still on the list are worth keeping.
      const next = [...cur.filter((id) => jobs.some((j) => j.id === id)), jobId];
      AsyncStorage.setItem(DISMISSED_CANCELLED_KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, [jobs]);
  // True while the job list is the server's answer (not the FALLBACK_JOBS
  // placeholder or the offline cache), so a missing job really means it was
  // taken away rather than that the network is down.
  const jobsSyncedRef = useRef(false);
  const [backStack, setBackStack] = useState([]);
  const [forwardStack, setForwardStack] = useState([]);
  const pageRef = useRef({ tab: 'Dashboard', jobId: null });

  const openPage = useCallback((page) => {
    const current = pageRef.current;
    if (current.tab === page.tab && current.jobId === page.jobId) return;
    setBackStack((stack) => [...stack, current]);
    setForwardStack([]);
    pageRef.current = page;
    setTab(page.tab);
    setActiveJob(page.jobId ? jobs.find((job) => job.id === page.jobId) || null : null);
  }, [jobs]);

  const goBack = useCallback(() => {
    setBackStack((stack) => {
      const previous = stack[stack.length - 1];
      if (!previous) return stack;
      setForwardStack((forward) => [...forward, pageRef.current]);
      pageRef.current = previous;
      setTab(previous.tab);
      setActiveJob(previous.jobId ? jobs.find((job) => job.id === previous.jobId) || null : null);
      return stack.slice(0, -1);
    });
  }, [jobs]);

  const goForward = useCallback(() => {
    setForwardStack((stack) => {
      const next = stack[stack.length - 1];
      if (!next) return stack;
      setBackStack((back) => [...back, pageRef.current]);
      pageRef.current = next;
      setTab(next.tab);
      setActiveJob(next.jobId ? jobs.find((job) => job.id === next.jobId) || null : null);
      return stack.slice(0, -1);
    });
  }, [jobs]);

  // Try to resume a previous Keycloak session on cold start. Guarded so a
  // slow/unavailable native module (e.g. secure storage on web) can never
  // leave the app stuck on the loading spinner. If the crew member has
  // opted in to biometric unlock, a restored session is held behind a
  // Face ID/fingerprint prompt rather than granted automatically.
  useEffect(() => {
    let settled = false;
    const finish = async (restored) => {
      if (settled) return;
      settled = true;
      if (restored && (await isBiometricEnabled().catch(() => false))) {
        setNeedsBiometric(true);
        setCheckingSession(false);
        return;
      }
      setAuthenticated(restored);
      setCheckingSession(false);
    };
    restoreSession()
      .then(finish)
      .catch(() => finish(false));
    const timeout = setTimeout(() => finish(false), 4000);
    return () => clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (authenticated) isBiometricEnabled().then(setBiometricOn).catch(() => {});
  }, [authenticated]);

  // Tracking starts by itself once a crew is signed in (asking for location
  // permission the first time), so dispatch sees every crew on duty without
  // anyone having to remember the Tracking button. The crew can still switch
  // it off; that holds until they sign in again. Demo mode never tracks.
  // Why tracking is not running (null while it runs): a reason reported to
  // dispatch, plus the error text when starting failed, shown in a banner.
  const [trackingReason, setTrackingReason] = useState(null);
  const [trackingError, setTrackingError] = useState('');
  const trackingRef = useRef({ on: false, reason: null });
  const startingRef = useRef(false);
  const applyTracking = useCallback((on, reason = null, error = '') => {
    trackingRef.current = { on, reason: on ? null : reason };
    setTrackingOn(on);
    setTrackingReason(on ? null : reason);
    setTrackingError(on ? '' : error);
  }, []);

  const runAutoStart = useCallback(async () => {
    if (!isAuthenticated() || startingRef.current) return;
    startingRef.current = true;
    setTrackingBusy(true);
    const crewId = myCrewId();
    let error = '';
    const { on, reason } = await autoStartCrewTracking(crewId).catch((err) => {
      // Not a permission problem (those come back as a reason): e.g. Android
      // refusing to start the foreground service. Keep the real message.
      error = err?.message || String(err);
      console.warn('[tracking] start failed:', error);
      return { on: false, reason: 'start_failed' };
    });
    // Re-reported on every start so dispatch's view heals after an offline
    // report was lost; the backend only alerts on a change.
    reportTrackingState(crewId, on ? 'on' : 'off', reason).catch(() => {});
    applyTracking(on, reason, error);
    setTrackingBusy(false);
    startingRef.current = false;
  }, [applyTracking]);

  useEffect(() => {
    if (authenticated) runAutoStart();
  }, [authenticated, runAutoStart]);

  // Whenever signed in (every 20 s and when the app comes back to the
  // front): warn the crew and dispatch if the phone's Location switch is off,
  // and retry tracking that failed to start, e.g. after the crew granted the
  // permission in Settings. A crew who switched tracking off is left alone.
  const [locationOff, setLocationOff] = useState(false);
  const locationOffRef = useRef(null);
  useEffect(() => {
    if (!authenticated || !isAuthenticated()) {
      locationOffRef.current = null;
      setLocationOff(false);
      return undefined;
    }
    const crewId = myCrewId();
    // Retries only on returning to the app or Location coming back, never on
    // the timer, so a permission prompt can't pop up every 20 s.
    const check = async (returned = false) => {
      const off = !(await isLocationServiceOn());
      const wasKnown = locationOffRef.current !== null;
      const changed = off !== locationOffRef.current;
      locationOffRef.current = off;
      setLocationOff(off);
      const { on, reason } = trackingRef.current;
      if (off) {
        if (changed) reportTrackingState(crewId, 'off', 'location_services_off').catch(() => {});
      } else if (!on && reason !== 'turned_off') {
        if (returned || (changed && wasKnown)) runAutoStart();
      } else if (changed && wasKnown && on) {
        reportTrackingState(crewId, 'on').catch(() => {});
      }
    };
    check();
    const timer = setInterval(() => check(), 20000);
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(true); });
    return () => { clearInterval(timer); sub.remove(); };
  }, [authenticated, runAutoStart]);

  const openAppSettings = useCallback(() => { Linking.openSettings().catch(() => {}); }, []);

  const openLocationSettings = useCallback(() => {
    if (Platform.OS === 'android') {
      Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS').catch(() => Linking.openSettings());
    } else {
      Linking.openSettings().catch(() => {});
    }
  }, []);

  const handleBiometricUnlock = useCallback(async () => {
    setBiometricBusy(true);
    setBiometricError('');
    try {
      const ok = await biometricUnlock();
      if (ok) {
        setNeedsBiometric(false);
        setAuthenticated(true);
      } else {
        setBiometricError('Unlock failed or was cancelled.');
      }
    } catch {
      setBiometricError('Biometric unlock is unavailable on this device.');
    } finally {
      setBiometricBusy(false);
    }
  }, []);

  // Auto-prompt once as soon as the lock screen appears.
  useEffect(() => {
    if (needsBiometric) handleBiometricUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBiometric]);

  const toggleBiometric = useCallback(async () => {
    if (biometricOn) {
      await setBiometricEnabled(false);
      setBiometricOn(false);
      return;
    }
    const ok = await biometricUnlock().catch(() => false);
    if (ok) {
      await setBiometricEnabled(true);
      setBiometricOn(true);
    }
  }, [biometricOn]);

  const toggleTracking = useCallback(async () => {
    if (trackingBusy) return;
    console.log('[toggleTracking] pressed, current state:', trackingOn);
    setTrackingBusy(true);
    try {
      if (trackingOn) {
        console.log('[toggleTracking] stopping...');
        await stopCrewTracking();
        await setTrackingPausedByCrew(true);
        console.log('[toggleTracking] stopped.');
        applyTracking(false, 'turned_off');
        reportTrackingState(crew.id, 'off', 'turned_off').catch(() => {});
        return;
      }
      console.log('[toggleTracking] starting, crew.id =', crew.id);
      await setTrackingPausedByCrew(false);
      const { on, reason } = await startCrewTracking(crew.id);
      console.log('[toggleTracking] startCrewTracking returned:', on, reason);
      applyTracking(on, reason);
      reportTrackingState(crew.id, on ? 'on' : 'off', reason).catch(() => {});
    } catch (err) {
      const error = err?.message || String(err);
      console.log('[toggleTracking] ERROR:', error);
      applyTracking(false, 'start_failed', error);
      reportTrackingState(crew.id, 'off', 'start_failed').catch(() => {});
    } finally {
      setTrackingBusy(false);
    }
  }, [trackingOn, trackingBusy, crew.id]);

  // Off duty = not tracked: signing out stops tracking (points already
  // recorded still upload) and the next sign-in starts it again.
  const signOut = useCallback(async () => {
    // Report before the token is cleared, but never let a dead network hold
    // up signing out.
    await Promise.race([
      reportTrackingState(myCrewId(), 'off', 'signed_out').catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await stopCrewTracking().catch(() => {});
    await setTrackingPausedByCrew(false);
    applyTracking(false, 'signed_out');
    await authLogout();
    await clearJobCache();
    await clearWorkOrderCache();
    setWorkOrderServer(null);
    setLastMembers([]);
    // Nothing of this crew's session may carry over to the next sign-in on
    // the same phone (a stale notice, or an open job closed as "reassigned").
    jobsSyncedRef.current = false;
    pageRef.current = { ...pageRef.current, jobId: null };
    setActiveJob(null);
    setJobs(FALLBACK_JOBS);
    setNotice('');
    setAuthenticated(false);
  }, [applyTracking]);

  // OMS-03: today's work order. The date is the phone's, so the screen moves
  // to the new day by itself after midnight. Offline, the last answer stays.
  const loadWorkOrder = useCallback(async () => {
    const date = localDate();
    setWorkDate(date);
    const [cached, pending, members] = await Promise.all([getCachedWorkOrder(), getPendingWorkOrder(), getLastMembers()]);
    setWorkOrderLocal(pending);
    setLastMembers(members);
    if (cached) setWorkOrderServer((current) => current || cached);
    try {
      const { workOrder } = await getWorkOrder(date);
      if (workOrder) {
        setWorkOrderServer(workOrder);
        cacheWorkOrder(workOrder);
      }
    } catch {
      // no signal: keep showing the cached work order
    }
  }, []);

  const refresh = useCallback(() => {
    if (!authenticated) return;
    getCurrentCrew().then(setCrew).catch(() => {});
    loadWorkOrder().catch(() => {});
    fetchMyJobs()
      .then(({ jobs: items, fromServer }) => {
        if (!Array.isArray(items)) return;
        // From the server an empty list is a real answer: the crew's last job
        // may have been reassigned. The offline fallback is only used when it
        // has something to show, and never counts as a server answer.
        if (!fromServer && !items.length) return;
        jobsSyncedRef.current = fromServer;
        setJobs(items);
        if (fromServer && isAuthenticated()) {
          // The dashboard sees the phone got each job; a new one rings.
          reportDelivered(items);
          findNewJobs(myCrewId(), items).then((fresh) => {
            if (!fresh.length) return;
            alertNewJobs(fresh);
            showGlimpse({
              kind: 'job',
              title: fresh.length === 1 ? `New job assigned: ${fresh[0].id}` : `${fresh.length} new jobs assigned`,
              text: fresh.length === 1 ? [fresh[0].severity, fresh[0].title, fresh[0].address].filter(Boolean).join(' · ') : fresh.map((j) => j.id).join(', '),
              jobId: fresh[0].id,
            });
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [authenticated, loadWorkOrder, showGlimpse]);

  // Phone notifications (sound) need a channel and the crew's permission.
  useEffect(() => {
    if (authenticated && isAuthenticated()) setupAlerts();
  }, [authenticated]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The open job screen is a snapshot. When a refresh shows the job is no
  // longer this crew's (rebalanced or reassigned by dispatch), close it so
  // the crew doesn't keep working on, or updating, another crew's job.
  useEffect(() => {
    if (!activeJob || !jobsSyncedRef.current) return;
    const fresh = jobs.find((j) => j.id === activeJob.id);
    const me = isAuthenticated() ? myCrewId() : null;
    const movedAway = !!(fresh && me && fresh.assignedCrewId && fresh.assignedCrewId !== me);
    if (fresh?.cancelled) {
      pageRef.current = { ...pageRef.current, jobId: null };
      setActiveJob(null);
      addNotice(`${fresh.id} was cancelled by the control room. It is listed under Pending Sync.`);
      return;
    }
    if (fresh && !movedAway) {
      // OMS-03: the open job screen follows the server's lock state, and the
      // status the control room set (returned for correction, locked).
      setActiveJob((current) => {
        if (!current || current.id !== fresh.id) return current;
        const serverDriven = fresh.locked || fresh.status === 'Requires Revisit';
        // The site position can change (dispatch corrects the incident's
        // location); the On Site check must measure against the new one.
        const samePlace = current.coordinates?.lat === fresh.coordinates?.lat && current.coordinates?.lon === fresh.coordinates?.lon;
        if (samePlace && current.locked === fresh.locked && current.undoUntil === fresh.undoUntil && (!serverDriven || current.status === fresh.status)) return current;
        return { ...current, coordinates: fresh.coordinates, locked: fresh.locked, undoUntil: fresh.undoUntil, ...(serverDriven ? { status: fresh.status } : {}) };
      });
      return;
    }
    pageRef.current = { ...pageRef.current, jobId: null };
    setActiveJob(null);
    addNotice(`This job was reassigned: ${activeJob.id} is no longer assigned to your crew.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs]);

  // OMS messages are polled while the authenticated crew app is connected.
  useEffect(() => {
    if (!authenticated || !isAuthenticated() || !crew.id) {
      setCrewMessages([]);
      return undefined;
    }
    let cancelled = false;
    const loadMessages = () => {
      getCrewMessages(crew.id)
        .then(async (items) => {
          if (cancelled || !Array.isArray(items)) return;
          setCrewMessages(items);
          const fresh = await findNewMessages(crew.id, items);
          if (cancelled || !fresh.length) return;
          alertNewMessages(fresh);
          const last = fresh[fresh.length - 1];
          showGlimpse({
            kind: 'message',
            title: fresh.length === 1 ? `Message from ${last.sender || 'control room'}` : `${fresh.length} new messages from the control room`,
            text: `${last.job_id ? last.job_id + ': ' : ''}${last.body}`,
            jobId: last.job_id || null,
          });
        })
        .catch(() => {});
    };
    loadMessages();
    const interval = setInterval(loadMessages, MESSAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [authenticated, crew.id, showGlimpse]);

  const unreadMessages = crewMessages.filter((m) => !isOwnMessage(m) && Date.parse(m.ts) > messagesReadAt).length;
  const openMessages = useCallback(() => {
    const now = Date.now();
    setMessagesReadAt(now);
    AsyncStorage.setItem(MESSAGES_READ_KEY, String(now)).catch(() => {});
    setMessagesVisible(true);
  }, []);
  const reloadMessages = useCallback(() => {
    if (!crew.id || !isAuthenticated()) return Promise.resolve();
    return getCrewMessages(crew.id).then((items) => Array.isArray(items) && setCrewMessages(items)).catch(() => {});
  }, [crew.id]);

  // The glimpse opens what it is about: the job, or the messages.
  const openGlimpse = useCallback(() => {
    const g = glimpse;
    setGlimpse(null);
    if (!g) return;
    if (g.kind === 'job' && g.jobId && jobs.some((j) => j.id === g.jobId)) {
      setMessagesVisible(false);
      openPage({ tab: 'Dashboard', jobId: g.jobId });
    } else {
      openMessages();
    }
  }, [glimpse, jobs, openPage, openMessages]);

  const reloadPending = useCallback(() => getQueueItems()
    .then((items) => {
      setPendingItems(items);
      setPendingCount(items.length);
    })
    .catch(() => {}), []);

  // Send pending-sync items (status changes, photos, QR scans made without
  // signal): on sign-in, as soon as the network comes back, and every 30 s.
  const syncPending = useCallback(() => {
    if (!authenticated) return Promise.resolve();
    // Demo mode has no real backend to flush against, and re-fetching demo
    // jobs would just overwrite locally-advanced statuses — only refresh the
    // pending list for display.
    if (!isAuthenticated()) return reloadPending();
    return flushQueue()
      .then((result) => {
        (result?.dropped ?? []).forEach((item) => addNotice(droppedUpdateNotice(item)));
        // OMS-03: accepted by the server but not applied (late, or the job is locked).
        (result?.notApplied ?? []).forEach((item) => addNotice(`${itemLabel(item)} ${item.reason}`));
        return reloadPending();
      })
      .then(refresh)
      .catch(() => {});
  }, [authenticated, refresh, reloadPending, addNotice]);

  useEffect(() => {
    if (!authenticated) return undefined;
    syncPending();
    const interval = setInterval(syncPending, JOB_POLL_INTERVAL_MS);
    const subscription = Network.addNetworkStateListener((state) => {
      // isConnected, not internet reachability: the server may be on a
      // local network (the PC hotspot) with no internet behind it.
      if (state.isConnected) syncPending();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [authenticated, syncPending]);

  // Upload GPS fixes recorded while offline: immediately when the network
  // comes back, plus a periodic retry. The background task also flushes on
  // each new fix; this covers the "app open, crew parked at a site" case
  // where no new fix arrives to trigger it.
  useEffect(() => {
    if (!authenticated || !canUseMapServer()) return undefined;
    const flush = () => flushLocations().then((r) => setPendingLocations(r.remaining)).catch(() => {});
    getPendingLocationCount().then(setPendingLocations).catch(() => {});
    flush();
    const interval = setInterval(flush, 60000);
    const subscription = Network.addNetworkStateListener((state) => {
      if (state.isConnected) flush(); // flushLocations re-checks reachability itself
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [authenticated]);

  // Fetch/refresh the offline map pack automatically, but only on Wi-Fi
  // (it's tens of MB). A no-op when the installed pack is already current.
  useEffect(() => {
    if (!authenticated || !canUseMapServer()) return;
    Network.getNetworkStateAsync()
      .then((state) => {
        if (state.type === Network.NetworkStateType.WIFI) {
          downloadPack().catch(() => {});
        }
      })
      .catch(() => {});
  }, [authenticated]);

  // OMS-03: the server decides. Take over its status, lock and undo window
  // from an answer, and say so when an update was not applied.
  const applyServerJob = useCallback((jobId, res) => {
    const { fields, notice } = serverJobUpdate(res);
    if (fields) {
      setJobs((current) => current.map((j) => (j.id === jobId ? { ...j, ...fields } : j)));
      setActiveJob((current) => (current?.id === jobId ? { ...current, ...fields } : current));
    }
    if (notice) addNotice(`${jobId} ${notice}`);
  }, [addNotice]);

  const handleAdvance = useCallback(async (job, nextStatus, opts = {}) => {
    const location = await getLocation();
    // OMS-01: a gated planned-outage status change (Work Started / Work
    // Finished) goes to the server first and the screen moves only once it
    // was accepted. Never queued: the server would refuse a stale one, and it
    // would sit in Pending Sync forever. Throws so the job screen can say so.
    if (opts.onlineOnly) {
      try {
        await updatePlannedJobStatus(job.id, nextStatus, location);
      } catch (err) {
        if (isNotYourJob(err)) refresh(); // the job screen closes once the list drops it
        throw err;
      }
      setJobs((current) => current.map((j) => (j.id === job.id ? { ...j, status: nextStatus } : j)));
      setActiveJob((current) => current?.id === job.id ? { ...current, status: nextStatus } : current);
      return;
    }
    setJobs((current) => current.map((j) => (j.id === job.id ? { ...j, status: nextStatus } : j)));
    setActiveJob((current) => current?.id === job.id ? { ...current, status: nextStatus } : current);

    // Demo mode has no real backend to sync with — queue immediately so
    // the pending-sync section actually shows something, instead of the
    // update silently "succeeding" against nothing.
    const enqueue = async () => {
      // The crew that made the update goes with it, so the server can refuse
      // it if the job moves to another crew meanwhile.
      await queueUpdate({ id: job.id, status: nextStatus, location, crewId: isAuthenticated() ? myCrewId() : null, queuedAt: Date.now() });
      await reloadPending();
    };
    if (!isAuthenticated()) {
      await enqueue();
      return;
    }

    // Older updates still waiting: this one goes behind them, so the server
    // gets them in the order the crew made them.
    if ((await getQueueLength()) > 0) {
      await enqueue();
      syncPending();
      return;
    }
    try {
      applyServerJob(job.id, await updateJobStatus(job.id, nextStatus, location));
    } catch (err) {
      if (isRefusal(err)) {
        // Refused (e.g. 409 NOT_YOUR_JOB): queueing would only be refused
        // again. Undo the optimistic status and re-read the job list.
        setJobs((current) => current.map((j) => (j.id === job.id ? { ...j, status: job.status } : j)));
        setActiveJob((current) => current?.id === job.id ? { ...current, status: job.status } : current);
        addNotice(droppedUpdateNotice({ id: job.id, status: nextStatus, code: err.code, message: err.message }));
        refresh();
        return;
      }
      // Network or server error: keep it and retry.
      await enqueue();
    }
  }, [refresh, addNotice, reloadPending, syncPending, applyServerJob]);

  // OMS-03: start or end the crew's day. Sent at once when there is signal
  // and nothing older is waiting; otherwise queued behind the waiting items
  // (so the day ends after the job updates it reports on). Returns true when
  // the Today screen can go back to the work order view.
  const sendWorkOrder = useCallback(async (kind, payload) => {
    const crewId = isAuthenticated() ? myCrewId() : crew.id;
    const woId = workOrderId(crewId, payload.date);
    const what = kind === 'start' ? 'start of day' : 'end of day';
    const keepOffline = async () => {
      if (!(await queueWorkOrder(kind, woId, crewId, payload))) return false;
      await setPendingWorkOrder(crewId, payload.date, kind, payload);
      setWorkOrderLocal(await getPendingWorkOrder());
      await reloadPending();
      addNotice(`No signal: the ${what} is saved on the phone and will be sent automatically.`);
      return true;
    };
    setWorkOrderBusy(true);
    try {
      if (isAuthenticated() && (await getQueueLength()) > 0) {
        const queued = await keepOffline();
        syncPending();
        return queued;
      }
      const res = await (kind === 'start' ? startWorkOrder : closeWorkOrder)(payload, crewId);
      if (res?.workOrder) {
        setWorkOrderServer(res.workOrder);
        cacheWorkOrder(res.workOrder);
      }
      if (res?.applied === false) addNotice(`${woId}: ${what} not applied: ${res.reason}`);
      return true;
    } catch (err) {
      if (isRefusal(err)) {
        addNotice(`${woId}: ${what} refused: ${err.message}`);
        return false;
      }
      return keepOffline();
    } finally {
      setWorkOrderBusy(false);
    }
  }, [crew.id, addNotice, reloadPending, syncPending]);

  const startDay = useCallback(async ({ members, checks, note }) => {
    const location = await getLocation().catch(() => null);
    const crewId = isAuthenticated() ? myCrewId() : crew.id;
    const payload = startPayload({ crewId, date: localDate(), members, checks, note, location });
    saveLastMembers(payload.members);
    setLastMembers(payload.members);
    return sendWorkOrder('start', payload);
  }, [crew.id, sendWorkOrder]);

  const endDay = useCallback(({ open, reasons, notes, remarks, signOff }) => {
    const crewId = isAuthenticated() ? myCrewId() : crew.id;
    return sendWorkOrder('close', closePayload({ crewId, date: workDate, open, reasons, notes, remarks, signOff }));
  }, [crew.id, workDate, sendWorkOrder]);

  const workOrder = viewWorkOrder({ crewId: isAuthenticated() ? myCrewId() : crew.id, date: workDate, server: workOrderServer, local: workOrderLocal });

  if (checkingSession) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <ActivityIndicator size="large" color="#1F3864" />
      </SafeAreaView>
    );
  }

  if (needsBiometric) {
    return (
      <SafeAreaView style={[styles.loginSafe, styles.center, { padding: 24 }]}>
        <Text style={styles.loginTitle}>🔒</Text>
        <Text style={[styles.loginTitle, { fontSize: 20, marginTop: 12 }]}>Unlock OMS Crew</Text>
        <Text style={[styles.loginSubtitle, { textAlign: 'center' }]}>
          Confirm it's you with Face ID / fingerprint to resume your session.
        </Text>
        {biometricError ? <Text style={styles.error}>{biometricError}</Text> : null}
        <Pressable style={[styles.signIn, { marginTop: 20 }]} disabled={biometricBusy} onPress={handleBiometricUnlock}>
          <Text style={styles.signInText}>{biometricBusy ? 'Checking…' : 'Try again'}</Text>
          <Text style={styles.signInArrow}>→</Text>
        </Pressable>
        <Pressable
          style={styles.demoBtn}
          onPress={async () => {
            await signOut();
            setNeedsBiometric(false);
          }}
        >
          <Text style={styles.demoBtnText}>Sign out instead</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!authenticated) {
    return <CrewLogin onSuccess={() => setAuthenticated(true)} />;
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor="#173355" />
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerIdentity}>
            <Text style={styles.kicker}>OMS CREW</Text>
            <Text style={styles.crewName} numberOfLines={1}>{crew.name}</Text>
            <Text style={styles.role} numberOfLines={1}>{crew.role} · {crew.id}</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.historyControls}>
              <Pressable style={[styles.historyButton, !backStack.length && styles.historyButtonOff]} disabled={!backStack.length} onPress={goBack} accessibilityLabel="Go back">
                <Text style={styles.historyButtonText}>‹</Text>
              </Pressable>
              <Pressable style={[styles.historyButton, !forwardStack.length && styles.historyButtonOff]} disabled={!forwardStack.length} onPress={goForward} accessibilityLabel="Go forward">
                <Text style={styles.historyButtonText}>›</Text>
              </Pressable>
            </View>
            {!isAuthenticated() && (
              <View style={styles.demoBadge}>
                <Text style={styles.demoBadgeText}>DEMO MODE</Text>
              </View>
            )}
            {pendingCount > 0 && (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingText}>{pendingCount} queued</Text>
              </View>
            )}
          </View>
        </View>
        <View style={styles.actionBar}>
          {isAuthenticated() && (
            <HeaderAction
              label="Messages"
              count={unreadMessages}
              onPress={openMessages}
              accessibilityLabel="Open OMS messages"
            />
          )}
          {isAuthenticated() && (
            <HeaderAction
              label="Biometric"
              on={biometricOn}
              onPress={toggleBiometric}
              accessibilityLabel={biometricOn ? 'Biometric unlock is on, tap to turn off' : 'Turn on biometric unlock'}
            />
          )}
          <HeaderAction
            label={trackingBusy ? 'Updating…' : 'Tracking'}
            on={trackingOn}
            count={pendingLocations}
            onPress={toggleTracking}
            disabled={trackingBusy}
            accessibilityLabel={
              (trackingOn ? 'Location tracking is on, tap to turn off' : 'Turn on location tracking') +
              (pendingLocations > 0 ? `, ${pendingLocations} locations saved offline` : '')
            }
          />
          <HeaderAction
            label="Sign out"
            danger
            onPress={signOut}
            accessibilityLabel="Sign out"
          />
        </View>
      </View>
      {(() => {
        // One warning at a time, most fixable first. None when the crew
        // switched tracking off themselves (the Tracking button shows that).
        let banner = null;
        if (locationOff) {
          banner = { title: 'Location is off', text: "Dispatch can't see where you are. Tap to turn on Location.", onPress: openLocationSettings };
        } else if (trackingReason === 'permission_denied' || trackingReason === 'background_permission_denied') {
          banner = {
            title: 'Location permission needed',
            text: trackingReason === 'background_permission_denied'
              ? 'Tap, open Permissions > Location and choose "Allow all the time".'
              : 'Tap, open Permissions > Location and allow location.',
            onPress: openAppSettings,
          };
        } else if (trackingReason === 'start_failed') {
          banner = { title: "Tracking couldn't start", text: `${trackingError || 'Unknown error'}. Tap to try again.`, onPress: runAutoStart };
        }
        if (!banner || (trackingBusy && !locationOff)) return null;
        return (
          <Pressable style={styles.locationOffBanner} onPress={banner.onPress} accessibilityRole="button" accessibilityLabel={`${banner.title}. ${banner.text}`}>
            <Text style={styles.locationOffTitle}>{banner.title}</Text>
            <Text style={styles.locationOffText}>{banner.text}</Text>
          </Pressable>
        );
      })()}
      <GlimpseBanner glimpse={glimpse} onPress={openGlimpse} onDismiss={() => setGlimpse(null)} />
      {tab === 'Map' ? (
        // The map fills the screen between the header and the bottom bar.
        <View style={{ flex: 1, paddingBottom: 46 + insets.bottom }}>
          {notice ? <View style={styles.mapNotice}><NoticeBanner notice={notice} onDismiss={() => setNotice('')} /></View> : null}
          <CrewMap jobs={liveJobs} crew={crew} navRequest={mapNav} focus={mapFocus} />
        </View>
      ) : (
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 100 + insets.bottom }]}>
        <NoticeBanner notice={notice} onDismiss={() => setNotice('')} />
        {tab === 'Dashboard' ? (
          <>
            <Text style={styles.title}>Today&apos;s field work</Text>
            <Text style={styles.subtitle}>Priority outages assigned to your crew.</Text>
            <WorkOrderCard workOrder={workOrder} jobs={liveJobs} date={workDate} onPress={() => openPage({ tab: 'Today', jobId: null })} />
            <JobStats
              jobs={liveJobs}
              onSelect={(filter) => {
                setJobFilter(filter);
                openPage({ tab: 'Jobs' });
              }}
            />

            {(pendingItems.length > 0 || cancelledJobs.length > 0) && (
              <View style={styles.pendingSection}>
                <View style={styles.pendingSectionHeader}>
                  <Text style={styles.pendingSectionTitle}>PENDING SYNC</Text>
                  <View style={styles.pendingCountPill}>
                    <Text style={styles.pendingCountPillText}>{pendingItems.length + cancelledJobs.length}</Text>
                  </View>
                </View>
                {pendingItems.length > 0 && (
                <Text style={styles.pendingSectionSubtitle}>
                  Saved on the phone with no signal. They're sent automatically, with the time you made them, once there is signal.
                </Text>
                )}
                {cancelledJobs.map((job) => (
                  <View key={`cancelled-${job.id}`} style={styles.pendingItemRow}>
                    <View style={[styles.pendingDot, styles.cancelledDot]} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pendingItemTitle}>{job.id} · Cancelled by control room</Text>
                      <Text style={styles.pendingItemMeta}>{job.title} · {job.address}. No more updates are sent for it.</Text>
                    </View>
                    <Pressable style={styles.pendingDismiss} onPress={() => dismissCancelled(job.id)} accessibilityLabel={`Dismiss cancelled job ${job.id}`}>
                      <Text style={styles.pendingDismissText}>OK</Text>
                    </Pressable>
                  </View>
                ))}
                {pendingItems.map((item, i) => (
                  <View key={`${item.id}-${item.queuedAt ?? i}`} style={styles.pendingItemRow}>
                    <View style={styles.pendingDot} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.pendingItemTitle}>
                        {item.type === 'photo' ? `${item.id} · Photo` : item.type === 'scan' ? `${item.id} · QR scan ${item.scan?.assetId ?? ''}` : item.type === 'completion' ? `${item.id} · Completion form` : item.type === 'wo-start' ? `${item.id} · Start of day` : item.type === 'wo-close' ? `${item.id} · End of day` : item.type === 'checklist' ? `${item.id} · Priority checklist` : `${item.id} → ${item.status}`}
                      </Text>
                      <Text style={styles.pendingItemMeta}>
                        {item.queuedAt ? `Queued ${timeAgo(item.queuedAt)}` : 'Queued offline'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            <Text style={styles.section}>MY JOBS</Text>
            {!liveJobs.length ? <Text style={styles.mapEmpty}>No jobs assigned.</Text> : null}
            {liveJobs.map((job) => (
              <JobCard key={job.id} job={job} onPress={() => openPage({ tab: 'Dashboard', jobId: job.id })} />
            ))}
          </>
        ) : tab === 'Today' ? (
          <DailyWorkOrder
            crew={crew}
            jobs={liveJobs}
            date={workDate}
            workOrder={workOrder}
            lastMembers={lastMembers}
            busy={workOrderBusy}
            onStart={startDay}
            onEnd={endDay}
            onOpenJob={(job) => openPage({ tab: 'Today', jobId: job.id })}
          />
        ) : tab === 'Jobs' ? (
          <NativeJobsPage
            jobs={liveJobs}
            filter={jobFilter}
            onFilter={setJobFilter}
            onPressJob={(job) => openPage({ tab: 'Jobs', jobId: job.id })}
          />
        ) : tab === 'Profile' ? (
          <ProfileScreen crew={crew} jobs={liveJobs} onLogout={signOut} />
        ) : (
          <View style={styles.empty}>
            <Text style={styles.title}>{tab}</Text>
            <Text style={styles.subtitle}>This field workspace is ready for your next assignment.</Text>
          </View>
        )}
      </ScrollView>
      )}
      <View style={[styles.nav, { paddingBottom: 12 + insets.bottom }]}>
        {['Dashboard', 'Today', 'Jobs', 'Map', 'Profile'].map((item) => (
          <Pressable
            key={item}
            onPress={() => {
              setMapNav(null);
              setMapFocus(null);
              openPage({ tab: item, jobId: null });
            }}
            style={styles.navItem}
          >
            <Text style={[styles.navText, tab === item && styles.navActive]}>
              {item}
            </Text>
          </Pressable>
        ))}
      </View>

      <Modal visible={!!activeJob} animationType="slide" onRequestClose={goBack}>
        {activeJob && (
          <JobDetail
            job={activeJob}
            crew={crew}
            onClose={goBack}
            onAdvance={handleAdvance}
            onServerJob={applyServerJob}
            notice={notice}
            onDismissNotice={() => setNotice('')}
            onQueued={reloadPending}
            onMessageSent={reloadMessages}
            glimpse={glimpse}
            onGlimpse={openGlimpse}
            onDismissGlimpse={() => setGlimpse(null)}
            onNavigate={(job) => {
              setMapFocus(null);
              setMapNav({ jobId: job.id, at: Date.now() });
              openPage({ tab: 'Map', jobId: null });
            }}
            onShowOnMap={(point) => {
              setMapNav(null);
              setMapFocus({ ...point, at: Date.now() });
              openPage({ tab: 'Map', jobId: null });
            }}
          />
        )}
      </Modal>
      <Modal visible={messagesVisible} animationType="slide" onRequestClose={() => setMessagesVisible(false)}>
        <SafeAreaView style={styles.detailSafe}>
          <View style={styles.detailHeader}>
            <Text style={styles.detailId}>OMS messages</Text>
            <Pressable onPress={() => setMessagesVisible(false)}>
              <Text style={styles.detailBack}>Close</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.detailContent} keyboardShouldPersistTaps="handled">
            <Text style={styles.subtitle}>Messages for {crew.name}&apos;s assigned jobs.</Text>
            {!crewMessages.length ? <Text style={styles.mapEmpty}>No OMS messages yet.</Text> : null}
            {crewMessages.map((item) => (
              <View key={item.id} style={[styles.messageRow, isOwnMessage(item) && styles.messageRowOwn]}>
                <Text style={styles.messageBody}>{item.body}</Text>
                <Text style={styles.messageMeta}>{isOwnMessage(item) ? 'You' : item.sender} · {item.job_id} · {new Date(item.ts).toLocaleString()}</Text>
              </View>
            ))}
            {isAuthenticated() && <MessageComposer jobs={liveJobs.filter((j) => !isJobDone(j))} onSent={reloadMessages} />}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

// The crew writes to the control room. A message belongs to a job (the
// operator reads it on that incident); with several jobs the crew picks one.
// Online only: if it can't be sent the crew is told and the text stays.
function MessageComposer({ jobs, jobId: fixedJobId, onSent }) {
  const [jobId, setJobId] = useState(fixedJobId || jobs[0]?.id || null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!fixedJobId && !jobs.some((j) => j.id === jobId)) setJobId(jobs[0]?.id || null);
  }, [jobs, jobId, fixedJobId]);
  if (!fixedJobId && !jobs.length) return <Text style={styles.assetValue}>Messages to the control room go with a job; you have no open job.</Text>;
  const send = async () => {
    const body = text.trim();
    if (!body || !jobId || busy) return;
    setBusy(true);
    setStatus('');
    try {
      const res = await sendJobMessage(jobId, body);
      if (res?.applied === false) {
        setStatus(`Not sent: ${res.reason || 'not applied'}`);
      } else {
        setText('');
        setStatus('Sent to the control room.');
        onSent?.();
      }
    } catch (err) {
      setStatus(isRetryable(err) ? 'No signal: message not sent. Try again once there is signal.' : `Not sent: ${err?.message || 'refused'}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.composer}>
      <Text style={styles.sectionSmall}>MESSAGE THE CONTROL ROOM</Text>
      {!fixedJobId && jobs.length > 1 && (
        <View style={styles.composerJobs}>
          {jobs.map((j) => (
            <Pressable key={j.id} onPress={() => setJobId(j.id)} style={[styles.composerJob, jobId === j.id && styles.composerJobOn]}>
              <Text style={[styles.composerJobText, jobId === j.id && styles.composerJobTextOn]}>{j.id}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {!fixedJobId && jobs.length === 1 && <Text style={styles.messageMeta}>About {jobs[0].id} · {jobs[0].title}</Text>}
      <TextInput
        style={styles.composerInput}
        value={text}
        onChangeText={setText}
        placeholder="Type a message to the OMS operator"
        placeholderTextColor="#9aa8bb"
        multiline
        maxLength={1000}
      />
      <Pressable style={[styles.primaryBtn, (!text.trim() || busy) && { opacity: 0.5 }]} onPress={send} disabled={!text.trim() || busy}>
        <Text style={styles.primaryBtnText}>{busy ? 'Sending…' : 'Send message'}</Text>
      </Pressable>
      {status ? <Text style={styles.assetValue}>{status}</Text> : null}
    </View>
  );
}

// OMS-03: the day's work order at a glance on the Dashboard; opens Today.
function WorkOrderCard({ workOrder, jobs, date, onPress }) {
  const summary = summarize(dayJobs(jobs, date));
  const status = workOrder?.status || 'not_started';
  const text = status === 'not_started'
    ? 'Day not started. Tap to start your day.'
    : status === 'started'
      ? `${summary.done} of ${summary.total} jobs done today`
      : 'Day ended.';
  return (
    <Pressable style={[styles.woCard, status === 'not_started' && styles.woCardTodo]} onPress={onPress} accessibilityRole="button" accessibilityLabel={`Today's work order. ${text}`}>
      <View style={{ flex: 1 }}>
        <Text style={styles.woCardTitle}>TODAY&apos;S WORK ORDER{workOrder?.pendingSync ? ' · WAITING TO SYNC' : ''}</Text>
        <Text style={styles.woCardText}>{text}</Text>
      </View>
      <Text style={styles.woCardArrow}>›</Text>
    </Pressable>
  );
}

function JobStats({ jobs, active, onSelect }) {
  const count = (filter) => String(jobs.filter(JOB_FILTERS[filter].test).length);
  return (
    <View style={styles.stats}>
      <Stat value={count('all')} label="Total jobs" active={active === 'all'} onPress={() => onSelect('all')} />
      <Stat value={count('pending')} label="Pending jobs" active={active === 'pending'} onPress={() => onSelect('pending')} />
      <Stat value={count('done')} label="Jobs done" active={active === 'done'} onPress={() => onSelect('done')} />
    </View>
  );
}

function NativeJobsPage({ jobs, filter, onFilter, onPressJob }) {
  const { section, empty, test } = JOB_FILTERS[filter] || JOB_FILTERS.all;
  const shown = jobs.filter(test);

  return (
    <>
      <Text style={styles.title}>Jobs</Text>
      <Text style={styles.subtitle}>Track every assignment and its current status.</Text>
      <JobStats jobs={jobs} active={filter} onSelect={onFilter} />
      <Text style={styles.section}>{section}</Text>
      {!shown.length ? <Text style={styles.mapEmpty}>{empty}</Text> : null}
      {shown.map((job) => (
        <JobCard key={job.id} job={job} onPress={() => onPressJob(job)} />
      ))}
    </>
  );
}

function CrewLogin({ onSuccess }) {
  // The server was loaded from storage before this screen (restoreSession).
  const [server, setServerHost] = useState(getServer);
  const [serverDraft, setServerDraft] = useState(getServer);
  const [serverCheck, setServerCheck] = useState(null); // null | 'checking' | { api, keycloak } | { error }
  const discovery = useMemo(() => getDiscovery(), [server]);
  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: CLIENT_ID,
      redirectUri,
      responseType: AuthSession.ResponseType.Code,
      usePKCE: true,
      scopes: ['openid', 'profile'],
      // Always show the Keycloak login form: crews share phones, and a
      // leftover SSO session must not sign the next person in as the last.
      prompt: AuthSession.Prompt.Login,
    },
    discovery
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockStatus, setLockStatus] = useState({ locked: false, remainingMs: 0, attempts: 0 });
  const [enableBiometricNext, setEnableBiometricNext] = useState(false);

  useEffect(() => {
    getLockoutStatus().then(setLockStatus);
  }, []);

  // Keep the countdown fresh while locked.
  useEffect(() => {
    if (!lockStatus.locked) return;
    const interval = setInterval(() => getLockoutStatus().then(setLockStatus), 1000);
    return () => clearInterval(interval);
  }, [lockStatus.locked]);

  const submit = async () => {
    if (!request || busy) return;
    const current = await getLockoutStatus();
    if (current.locked) {
      setLockStatus(current);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const loginResult = await login(promptAsync, request);
      if (!loginResult?.success) {
        if (!loginResult?.countFailure) {
          setError('Sign-in was cancelled.');
          return;
        }
        const status = await recordFailedAttempt();
        setLockStatus(status);
        setError(
          status.locked
            ? `Too many failed attempts. Locked for ${Math.ceil(LOCKOUT_MS / 60000)} minutes.`
            : `Sign-in was cancelled or failed. ${MAX_ATTEMPTS - status.attempts} attempt(s) left.`
        );
        return;
      }
      await resetLoginAttempts();
      if (enableBiometricNext) {
        const bOk = await biometricUnlock().catch(() => false);
        if (bOk) await setBiometricEnabled(true);
      }
      onSuccess();
    } catch {
      const status = await recordFailedAttempt();
      setLockStatus(status);
      setError(`Could not reach the sign-in server at ${server}. Tap "Check" below to see what is unreachable.`);
    } finally {
      setBusy(false);
    }
  };

  const saveAndCheckServer = async () => {
    setServerCheck('checking');
    try {
      const host = await setServer(serverDraft);
      setServerHost(host);
      setServerDraft(host);
      setServerCheck(await checkServer());
    } catch (err) {
      setServerCheck({ error: err.message });
    }
  };

  const lockedMinutes = Math.ceil(lockStatus.remainingMs / 60000);

  return (
    <SafeAreaView style={styles.loginSafe}>
      <StatusBar barStyle="light-content" backgroundColor="#10201d" />
      <ScrollView contentContainerStyle={styles.login} keyboardShouldPersistTaps="handled">
        <Text style={styles.loginKicker}>OMS CREW</Text>
        <Text style={styles.loginTitle}>Crew sign in</Text>
        <Text style={styles.loginSubtitle}>Access your field operations workspace.</Text>

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {lockStatus.locked ? (
          <Text style={styles.error}>
            Account locked after {MAX_ATTEMPTS} failed attempts. Try again in {lockedMinutes} min.
          </Text>
        ) : null}

        <Pressable
          style={styles.checkboxRow}
          onPress={() => setEnableBiometricNext((v) => !v)}
        >
          <View style={[styles.checkbox, enableBiometricNext && styles.checkboxOn]} />
          <Text style={styles.checkboxLabel}>Enable biometric unlock next time</Text>
        </Pressable>

        <Pressable
          style={[styles.signIn, (!request || lockStatus.locked) && styles.btnOff]}
          disabled={!request || busy || lockStatus.locked}
          onPress={submit}
        >
          <Text style={styles.signInText}>
            {lockStatus.locked ? `Locked (${lockedMinutes} min)` : busy ? 'Signing in…' : 'Sign in with Keycloak'}
          </Text>
          <Text style={styles.signInArrow}>→</Text>
        </Pressable>

        <Pressable style={styles.demoBtn} onPress={onSuccess}>
          <Text style={styles.demoBtnText}>Continue in demo mode</Text>
        </Pressable>
        <Text style={styles.demoBtnHint}>
          No backend/Keycloak reachable yet? Skip sign-in and explore the app with sample jobs.
        </Text>

        <View style={styles.demo}>
          <Text style={styles.demoLabel}>OMS SERVER</Text>
          <View style={styles.serverRow}>
            <TextInput
              style={styles.serverInput}
              value={serverDraft}
              onChangeText={(text) => {
                setServerDraft(text);
                setServerCheck(null);
              }}
              placeholder="192.168.1.20"
              placeholderTextColor="#5f7b74"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="done"
              onSubmitEditing={saveAndCheckServer}
              editable={!busy}
            />
            <Pressable style={styles.serverBtn} onPress={saveAndCheckServer} disabled={busy || serverCheck === 'checking'}>
              <Text style={styles.serverBtnText}>{serverCheck === 'checking' ? '…' : 'Check'}</Text>
            </Pressable>
          </View>
          {serverCheck && serverCheck !== 'checking' ? (
            serverCheck.error ? (
              <Text style={styles.error}>{serverCheck.error}</Text>
            ) : (
              <>
                <Text style={styles.demoPassword}>
                  {serverCheck.api ? '✓' : '✗'} Backend :{API_PORT}   {serverCheck.keycloak ? '✓' : '✗'} Keycloak :{KEYCLOAK_PORT}
                </Text>
                {!serverCheck.api || !serverCheck.keycloak ? (
                  <Text style={styles.error}>Not reachable — check the IP, that the service is running, and the PC firewall.</Text>
                ) : null}
              </>
            )
          ) : null}
          <Text style={styles.demoPassword}>Realm: oms-upcl · Client: oms-mobile</Text>
        </View>
        <Text style={styles.loginFooter}>Crew access only · Offline capable</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// One chip in the header's action bar. `on` shows a status dot (green = on),
// `count` a small bubble, `danger` the red sign-out style.
function HeaderAction({ label, on, count, danger, onPress, disabled, accessibilityLabel }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.action,
        on && styles.actionOn,
        danger && styles.actionDanger,
        pressed && styles.actionPressed,
        disabled && styles.actionDisabled,
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
    >
      {on !== undefined && <View style={[styles.actionDot, on && styles.actionDotOn]} />}
      <Text style={[styles.actionText, danger && styles.actionTextDanger]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
        {label}
      </Text>
      {count > 0 && (
        <View style={styles.actionCount}>
          <Text style={styles.actionCountText}>{count > 99 ? '99+' : count}</Text>
        </View>
      )}
    </Pressable>
  );
}

function Stat({ value, label, active, onPress }) {
  const content = (
    <>
      <Text style={[styles.statValue, active && styles.statValueActive]}>{value}</Text>
      <Text style={[styles.statLabel, active && styles.statLabelActive]}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={styles.stat}>{content}</View>;
  return (
    <Pressable
      style={({ pressed }) => [styles.stat, active && styles.statActive, pressed && { opacity: 0.7 }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      accessibilityLabel={`${label}: ${value}`}
    >
      {content}
    </Pressable>
  );
}

function JobCard({ job, onPress }) {
  const severity = job.severity || 'Medium';
  const color = (severityColors && severityColors[severity]) || '#2f6fd6';
  return (
    <Pressable onPress={onPress} style={styles.card}>
      <View style={[styles.severity, { backgroundColor: color }]} />
      <View style={styles.cardBody}>
        <View style={styles.row}>
          <Text style={styles.jobId}>{job.id || 'JOB-—'}</Text>
          <Text style={styles.status}>{job.status || 'Unknown status'}</Text>
        </View>
        <View style={[styles.severityBadge, { backgroundColor: color }]}>
          <Text style={styles.severityBadgeText}>{severity.toUpperCase()}</Text>
        </View>
        <Text style={styles.jobTitle}>{job.title || 'Untitled job'}</Text>
        <Text style={styles.address}>{job.address || 'Location not available'}</Text>
        {jobPlanLine(job) ? <Text style={styles.planLine}>{jobPlanLine(job)}</Text> : null}
        <View style={styles.row}>
          <Text style={styles.meta}>{job.distance || 'Distance unknown'}</Text>
          <Text style={styles.meta}>{job.customers ?? 0} customers</Text>
        </View>
      </View>
    </Pressable>
  );
}

function PhotoCamera({ tag, onCapture, onClose }) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!permission) return <Text style={styles.assetValue}>Loading camera…</Text>;
  if (!permission.granted) {
    return (
      <View style={styles.photoCameraPermission}>
        <Text style={styles.assetValue}>Camera access is required to capture job evidence.</Text>
        <Pressable style={styles.primaryBtn} onPress={requestPermission}>
          <Text style={styles.primaryBtnText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.secondaryBtn} onPress={onClose}>
          <Text style={styles.secondaryBtnText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const capture = async () => {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    setError('');
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.5 });
      await onCapture(photo);
    } catch (err) {
      setError(err?.message || 'Could not capture the photo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.photoCamera}>
      <View>
        <CameraView ref={cameraRef} style={styles.photoCameraPreview} facing="back" />
        {tag ? <Text style={styles.photoCameraTag} pointerEvents="none">{tag.toUpperCase()} · lat/long added</Text> : null}
      </View>
      {error ? <Text style={styles.photoCameraError}>{error}</Text> : null}
      <View style={styles.photoCameraActions}>
        <Pressable style={styles.secondaryBtn} onPress={onClose} disabled={busy}>
          <Text style={styles.secondaryBtnText}>Cancel</Text>
        </Pressable>
        <Pressable style={styles.primaryBtn} onPress={capture} disabled={busy}>
          <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : 'Capture photo'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function JobDetail({ job, crew, onClose, onAdvance, onServerJob, onQueued, onNavigate, onShowOnMap, onMessageSent, glimpse, onGlimpse, onDismissGlimpse, notice, onDismissNotice }) {
  const [showSafety, setShowSafety] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showPhotoCamera, setShowPhotoCamera] = useState(false);
  const [assetId, setAssetId] = useState('');
  const [assetDetails, setAssetDetails] = useState(null);
  const [assetScans, setAssetScans] = useState([]);
  const [assetScanSaving, setAssetScanSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [photoCount, setPhotoCount] = useState(0);
  const [omsMessages, setOmsMessages] = useState([]);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [checklistDone, setChecklistDone] = useState(false);
  const [plannedMessage, setPlannedMessage] = useState('');
  // Asking the control room to give this job to another crew.
  const [reassign, setReassign] = useState(null); // the latest request from the server
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignReason, setReassignReason] = useState('');
  const [reassignBusy, setReassignBusy] = useState(false);
  // Shown while the crew is too far from the site for On Site / Work Started.
  const [siteMessage, setSiteMessage] = useState('');
  // The status button is at the bottom but the safety checklist / completion
  // steps it opens render near the top, so scroll them into view.
  const scrollRef = useRef(null);
  const flowY = useRef(0);

  // Completion flow: fault diagnosis -> parts used -> crew-lead sign-off.
  // Gates the final "Work Started" -> "Work Complete" transition.
  const [completionStep, setCompletionStep] = useState(null); // null | 'diagnosis' | 'parts' | 'signoff'
  const [diagnosis, setDiagnosis] = useState(null);
  const [partsUsed, setPartsUsed] = useState(null);
  const [signOff, setSignOff] = useState(null);
  // The safety checklist ticked before Work Started, sent with the completion form.
  const [safetyChecklist, setSafetyChecklist] = useState(null);
  // OMS-03: "Supply restored?" goes with the completion form.
  const [restored, setRestored] = useState(null);
  const [reopening, setReopening] = useState(false);
  // A completion form the server did not apply, kept on the phone: { form, reason }.
  const [undelivered, setUndelivered] = useState(null);
  const loadUndelivered = () => getUndeliveredCompletion(job.id).then(setUndelivered).catch(() => {});
  useEffect(() => { loadUndelivered(); }, [job.id, job.status]); // eslint-disable-line react-hooks/exhaustive-deps
  // Locked (completed, undo window over): the job is shown read-only.
  // Re-checked when the undo window ends while the screen is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const until = job.undoUntil ? Date.parse(job.undoUntil) : 0;
    if (!until || until <= Date.now()) return undefined;
    const t = setTimeout(() => setTick((n) => n + 1), until - Date.now() + 50);
    return () => clearTimeout(t);
  }, [job.undoUntil]);
  const readOnly = isReadOnly(job);

  useEffect(() => {
    // Photos still waiting in Pending sync count too, so a crew with no
    // signal on site is not blocked by the photo rule below.
    Promise.all([
      getJobPhotos(job.id).then((photos) => (Array.isArray(photos) ? photos.length : 0)).catch(() => 0),
      getQueueItems().then((items) => items.filter((i) => i.type === 'photo' && i.id === job.id).length).catch(() => 0),
    ]).then(([sent, queued]) => setPhotoCount(sent + queued));
    getAssetScans(job.id).then((scans) => setAssetScans(Array.isArray(scans) ? scans : [])).catch(() => {});
  }, [job.id]);

  // The crew opened the job: the dashboard shows they have seen it.
  useEffect(() => {
    if (!job.openedAt && isAuthenticated()) reportJobSeen(job.id, 'opened').catch(() => {});
    getReassignRequest(job.id).then((r) => setReassign(r?.request || null)).catch(() => {});
  }, [job.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = NEXT_STATUS[job.status];

  useEffect(() => {
    if (showSafety || completionStep) scrollRef.current?.scrollTo({ y: Math.max(0, flowY.current - 12), animated: true });
  }, [showSafety, completionStep]);

  const sendReassign = async () => {
    const reason = reassignReason.trim();
    if (reason.length < 3 || reassignBusy) return;
    setReassignBusy(true);
    try {
      const res = await requestReassignment(job.id, reason);
      setReassign(res?.request || null);
      setReassignOpen(false);
      setReassignReason('');
      setMessage(res?.duplicate ? 'You already asked; the control room has your request.' : 'Request sent. Keep working on the job until the control room reassigns it.');
    } catch (err) {
      setMessage(isRetryable(err) ? 'No signal: the request was not sent. Try again once there is signal.' : `Request refused: ${err?.message || 'unknown reason'}`);
    } finally {
      setReassignBusy(false);
    }
  };

  // OMS-01 gates for planned-outage jobs: Work Started needs the crew's own
  // isolation steps confirmed and the permit issued; Work Finished needs the
  // permit returned. Read live from the server (offline = stays closed), then
  // the usual safety checklist / completion flow runs. Fault jobs: unchanged.
  const plannedGated = !!job.planned && (next === 'Work Started' || next === 'Work Finished');
  const advance = () => {
    const sent = Promise.resolve(onAdvance(job, next, plannedGated ? { onlineOnly: true } : undefined));
    return plannedGated ? sent.catch((err) => setPlannedMessage(`Status NOT changed: ${err.message}`)) : sent;
  };

  const requestAdvance = async () => {
    if (!next || !checklistDone) return;
    // On Site / Work Started only at the site (the server checks it too).
    if (SITE_STATUSES.includes(next) && !job.planned && job.coordinates) {
      setAdvancing(true);
      const here = await getLocation({ allowCached: false }).catch(() => ({}));
      setAdvancing(false);
      const blocked = siteBlock(job, next, here);
      setSiteMessage(blocked || '');
      if (blocked) return;
    }
    if (plannedGated) {
      setPlannedMessage('');
      const view = await getPlannedOutage(job.id).catch(() => null);
      const blocked = gateFor(view, next);
      if (blocked) {
        setPlannedMessage(blocked);
        return;
      }
    }
    if (job.status === 'On Site') {
      // At least one site photo before work can start; asset scans stay optional.
      if (photoCount < 1) {
        setMessage('Take at least one site photo before starting work. Scanning the asset QR is optional.');
        return;
      }
      setShowSafety(true);
      return;
    }
    if (job.status === 'Work Started') {
      setCompletionStep('diagnosis');
      return;
    }
    setAdvancing(true);
    try {
      await advance();
    } finally {
      setAdvancing(false);
    }
  };

  // OMS-03: the completion form goes to the server before Work Finished
  // (fault jobs only; a planned job closes out through its permit). No
  // signal: it waits in Pending sync ahead of the status change, so the
  // server gets them in that order.
  const sendCompletion = async (form) => {
    if (!canSendCompletion(job)) return;
    try {
      const res = await postJobCompletion(job.id, form);
      if (res?.applied === false) {
        // Not lost: kept on the phone as "not delivered" (same clientRequestId).
        await keepUndeliveredCompletion(job.id, form, res.reason);
        setMessage(`Completion form not delivered: ${res.reason || 'not applied'}. It is kept on the phone; send it again below.`);
      } else if (res) {
        await clearUndeliveredCompletion(job.id);
      }
      loadUndelivered();
    } catch (err) {
      if (!isRetryable(err)) {
        setMessage(`Completion form refused by the server: ${err?.message || 'unknown reason'}`);
        return;
      }
      await queueCompletion(job.id, form);
      onQueued?.();
    }
  };

  const finishCompletion = async (finalSignOff) => {
    setSignOff(finalSignOff);
    setCompletionStep(null);
    setAdvancing(true);
    try {
      await sendCompletion(completionPayload({ jobId: job.id, diagnosis, partsUsed, restored, signOff: finalSignOff, checklist: safetyChecklist }));
      await advance();
    } finally {
      setAdvancing(false);
    }
  };

  // The priority checklist, once every item is ticked: a record for the
  // control room's timeline, not a gate (this screen gates itself). Not
  // waited for; no signal: it waits in Pending sync.
  const onPriorityChecklist = (allDone, items) => {
    setChecklistDone(allDone);
    if (!allDone) return;
    const body = { items, passedAt: new Date().toISOString() };
    postJobChecklist(job.id, body).catch(async (err) => {
      if (!isRetryable(err)) return;
      if (await queueChecklist(job.id, body)) onQueued?.();
    });
  };

  const resendCompletion = async () => {
    if (!undelivered || !canResendCompletion(job)) return;
    setAdvancing(true);
    try {
      await sendCompletion(undelivered.form);
    } finally {
      setAdvancing(false);
    }
  };

  // Undo Work Complete while the server's window is open. Online only: a
  // reopen that arrived later than the window would be refused anyway.
  const reopen = async () => {
    if (!canReopen(job)) return;
    setReopening(true);
    try {
      const res = await reopenJob(job.id);
      onServerJob?.(job.id, res);
      if (res?.applied) {
        setSignOff(null);
        setMessage('Job reopened. The control room has been told; finish it again when the work is done.');
      }
    } catch (err) {
      setMessage(isRetryable(err)
        ? 'No signal: the job could not be reopened. Try again once there is signal.'
        : `Reopen refused by the server: ${err?.message || 'unknown reason'}`);
    } finally {
      setReopening(false);
    }
  };

  const takePhoto = () => {
    if (photoCount >= MAX_JOB_PHOTOS) {
      setMessage(`Photo limit reached: ${MAX_JOB_PHOTOS} photos for this job.`);
      return;
    }
    setMessage('');
    setShowPhotoCamera(true);
  };

  const stage = photoStage(job);
  const saveCapturedPhoto = async (photo) => {
    setUploading(true);
    try {
      const result = await uploadCapturedPhoto(job.id, photo, assetId ? `Asset: ${assetId}` : undefined, crew, stage);
      const where = fmtLatLon(result?.location);
      const tagged = `${PHOTO_STAGE_LABEL[stage]}${where ? ` · Lat/Long ${where}` : ''}`;
      if (result?.applied === false) {
        setMessage(`Photo not added to the job: ${result.reason || 'not applied'}. The control room can still see it.`);
        setShowPhotoCamera(false);
        return;
      }
      setPhotoCount((count) => count + 1);
      if (result?.queued) {
        onQueued?.();
        setMessage(`No signal: photo ${photoCount + 1} of ${MAX_JOB_PHOTOS} saved on the phone (${tagged}). It uploads by itself once there is signal (see Pending sync).`);
      } else {
        setMessage(`Photo ${photoCount + 1} of ${MAX_JOB_PHOTOS} stored (${tagged}).`);
      }
      setShowPhotoCamera(false);
    } catch (err) {
      setMessage(err?.message || 'Photo upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const loadMessages = async () => {
    setMessagesOpen(true);
    setMessagesLoading(true);
    try {
      const items = await getJobMessages(job.id);
      setOmsMessages(Array.isArray(items) ? items : []);
    } catch (err) {
      setMessage(err?.message || 'Could not load OMS messages.');
    } finally {
      setMessagesLoading(false);
    }
  };

  const handleAssetScan = async (rawValue) => {
    setAssetScanSaving(true);
    setMessage('Saving asset scan…');
    try {
      let parsedDetails = {};
      try {
        const parsed = JSON.parse(rawValue);
        if (parsed && typeof parsed === 'object') parsedDetails = parsed;
      } catch {
        parsedDetails = { value: rawValue };
      }
      const location = await getLocation({ allowCached: false });
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) {
        throw new Error('Location not available. Asset scan was not stored. Enable GPS and try again.');
      }
      const scan = {
        rawValue,
        assetId: parsedDetails.assetId || parsedDetails.asset_id || parsedDetails.id || parsedDetails.tag || rawValue,
        assetDetails: parsedDetails,
        lat: location.lat,
        lon: location.lon,
        crewId: crew?.id,
      };
      let saved;
      let queued = false;
      try {
        saved = await saveAssetScan(job.id, scan);
      } catch (err) {
        // No signal: keep the scan for pending sync instead of losing it.
        if (!isRetryable(err)) throw err;
        await queueScan(job.id, scan);
        onQueued?.();
        queued = true;
        saved = { id: `pending-${Date.now()}`, asset_id: scan.assetId, asset_details: parsedDetails, lat: scan.lat, lon: scan.lon, scanned_at: new Date().toISOString(), pending: true };
      }
      if (saved?.applied === false) {
        setShowScanner(false);
        setMessage(`Asset scan not added to the job: ${saved.reason || 'not applied'}. The control room can still see it.`);
        return;
      }
      setAssetId(saved.asset_id || saved.assetId || rawValue);
      setAssetDetails(saved.asset_details || parsedDetails);
      setAssetScans((current) => [saved, ...current]);
      setShowScanner(false);
      setMessage(queued
        ? 'No signal: asset scan saved on the phone. It uploads by itself once there is signal (see Pending sync).'
        : 'Asset QR details stored in the database.');
    } catch (err) {
      setMessage(err?.message || 'Asset scan could not be stored.');
    } finally {
      setAssetScanSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.detailSafe}>
      <View style={styles.detailHeader}>
        <Pressable onPress={onClose}>
          <Text style={styles.detailBack}>← Back</Text>
        </Pressable>
        <Text style={styles.detailId}>{job.id}</Text>
      </View>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.detailContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <GlimpseBanner glimpse={glimpse} onPress={onGlimpse} onDismiss={onDismissGlimpse} />
        <NoticeBanner notice={notice} onDismiss={onDismissNotice} />
        <Text style={[styles.jobTitle, { fontSize: 22 }]}>{job.title}</Text>
        <Text style={styles.address}>📍 {job.address}</Text>
        {jobPlanLine(job) ? <Text style={styles.planLine}>{jobPlanLine(job)}</Text> : null}
        <View style={styles.detailStats}>
          <View>
            <Text style={styles.statLabel}>Feeder</Text>
            <Text style={styles.statValue}>{job.feeder ?? '—'}</Text>
          </View>
          <View>
            <Text style={styles.statLabel}>Customers</Text>
            <Text style={styles.statValue}>{job.customers ?? '—'}</Text>
          </View>
          <View>
            <Text style={styles.statLabel}>Status</Text>
            <Text style={styles.statValue}>{job.status}</Text>
          </View>
        </View>

        <PriorityChecklist severity={job.severity} onChange={onPriorityChecklist} />

        {!checklistDone && (
          <View style={styles.checklistLock}>
            <Text style={styles.checklistLockText}>
              Complete the priority checklist above to unlock the rest of this job.
            </Text>
          </View>
        )}

        <View onLayout={(e) => { flowY.current = e.nativeEvent.layout.y; }}>
        {checklistDone && showSafety && (
          <SafetyChecklist
            onPass={(items) => {
              setSafetyChecklist(items);
              setShowSafety(false);
              setAdvancing(true);
              advance().finally(() => setAdvancing(false));
            }}
            onCancel={() => setShowSafety(false)}
          />
        )}

        {checklistDone && completionStep === 'diagnosis' && (
          <FaultDiagnosisWizard
            onComplete={(answers) => {
              setDiagnosis(answers);
              setCompletionStep('parts');
            }}
            onCancel={() => setCompletionStep(null)}
          />
        )}

        {checklistDone && completionStep === 'parts' && (
          <PartsPicker
            onComplete={(parts) => {
              setPartsUsed(parts);
              setCompletionStep('signoff');
            }}
            onCancel={() => setCompletionStep('diagnosis')}
          />
        )}

        {checklistDone && completionStep === 'signoff' && !job.planned && (
          <View style={styles.restoredBox}>
            <Text style={styles.sectionSmall}>SUPPLY RESTORED?</Text>
            <View style={styles.restoredRow}>
              {RESTORED_CHOICES.map((c) => (
                <Pressable key={c.value} onPress={() => setRestored(c.value)}
                  style={[styles.restoredChoice, restored === c.value && styles.restoredChoiceOn]}
                  accessibilityState={{ selected: restored === c.value }}>
                  <Text style={[styles.restoredChoiceText, restored === c.value && styles.restoredChoiceTextOn]}>{c.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
        {checklistDone && completionStep === 'signoff' && (
          <CrewLeadSignOff
            onComplete={finishCompletion}
            onCancel={() => setCompletionStep('parts')}
          />
        )}
        </View>

        {undelivered && !job.planned && (
          <View style={styles.checklistLock}>
            <Text style={styles.checklistLockText}>
              Completion form not delivered: {undelivered.reason}. It is kept on this phone.
            </Text>
            {canResendCompletion(job) ? (
              <Pressable style={styles.secondaryBtn} onPress={resendCompletion} disabled={advancing}>
                <Text style={styles.secondaryBtnText}>Send completion form again</Text>
              </Pressable>
            ) : (
              <Text style={styles.checklistLockText}>
                {job.locked ? 'The job is locked; tell the control room.' : 'It can be sent again once the job is Work Started.'}
              </Text>
            )}
          </View>
        )}

        {(checklistDone || readOnly) && (signOff || (isCompleted(job) && !job.planned)) && (
          <View style={styles.completionSummary}>
            <Text style={styles.completionSummaryTitle}>{readOnly ? `${SUBMITTED_LABEL} (locked)` : SUBMITTED_LABEL}</Text>
            {readOnly && (
              <Text style={styles.completionSummaryLine}>
                The job is locked. Anything else goes through the control room (they can return it for correction).
              </Text>
            )}
            {diagnosis && (
              <Text style={styles.completionSummaryLine}>
                Symptom: {diagText(diagnosis, 'symptom')} · Cause: {diagText(diagnosis, 'cause')} · Action: {diagText(diagnosis, 'action')}
              </Text>
            )}
            {diagnosis?.remarks ? <Text style={styles.completionSummaryLine}>Remarks: {diagnosis.remarks}</Text> : null}
            {partsUsed && partsUsed.length > 0 && (
              <Text style={styles.completionSummaryLine}>
                Parts: {partsUsed.map((p) => `${p.name} ×${p.qty}`).join(', ')}
              </Text>
            )}
            {restored && (
              <Text style={styles.completionSummaryLine}>
                Supply restored: {RESTORED_CHOICES.find((c) => c.value === restored)?.label}
              </Text>
            )}
            {signOff && (
              <Text style={styles.completionSummaryLine}>
                Signed off by {signOff.name} at {new Date(signOff.signedAt).toLocaleTimeString()}
              </Text>
            )}
            {canReopen(job) && (
              <Pressable style={styles.secondaryBtn} onPress={reopen} disabled={reopening}>
                <Text style={styles.secondaryBtnText}>
                  {reopening ? 'Reopening…' : `Reopen job (undo, until ${new Date(job.undoUntil).toLocaleTimeString()})`}
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {checklistDone && (
        <Pressable style={styles.secondaryBtn} onPress={() => {
          onNavigate(job);
        }}>
          <Text style={styles.secondaryBtnText}>Navigate to site</Text>
        </Pressable>
        )}
        {checklistDone && (
        <Pressable style={styles.secondaryBtn} onPress={loadMessages}>
          <Text style={styles.secondaryBtnText}>Messages with the control room</Text>
        </Pressable>
        )}
        {checklistDone && messagesOpen && (
          <View style={styles.messagesPanel}>
            <View style={styles.messagesHeader}>
              <Text style={styles.sectionSmall}>OMS JOB MESSAGES</Text>
              <Pressable onPress={() => setMessagesOpen(false)}>
                <Text style={styles.messagesClose}>Close</Text>
              </Pressable>
            </View>
            {messagesLoading ? <Text style={styles.assetValue}>Fetching messages…</Text> : null}
            {!messagesLoading && !omsMessages.length ? <Text style={styles.assetValue}>No messages from OMS yet.</Text> : null}
            {omsMessages.map((item) => (
              <View key={item.id} style={[styles.messageRow, isOwnMessage(item) && styles.messageRowOwn]}>
                <Text style={styles.messageBody}>{item.body}</Text>
                <Text style={styles.messageMeta}>{isOwnMessage(item) ? 'You' : item.sender} · {new Date(item.ts).toLocaleString()}</Text>
              </View>
            ))}
            {isAuthenticated() && !readOnly && (
              <MessageComposer jobs={[job]} jobId={job.id} onSent={() => { loadMessages(); onMessageSent?.(); }} />
            )}
          </View>
        )}

        {checklistDone && isAuthenticated() && !readOnly && !isJobDone(job) && (
          <View style={styles.reassignBox}>
            {reassign?.status === 'open' ? (
              <Text style={styles.assetValue}>
                Reassignment requested {new Date(reassign.created_at).toLocaleTimeString()}: "{reassign.reason}". Waiting for the control room; keep working on the job until it is moved.
              </Text>
            ) : reassign?.status === 'dismissed' && !reassignOpen ? (
              <Text style={styles.assetValue}>Your last reassignment request was declined{reassign.resolution ? `: ${reassign.resolution}` : ''}.</Text>
            ) : null}
            {reassign?.status !== 'open' && !reassignOpen && (
              <Pressable style={styles.secondaryBtn} onPress={() => setReassignOpen(true)}>
                <Text style={styles.secondaryBtnText}>Request reassignment</Text>
              </Pressable>
            )}
            {reassignOpen && (
              <>
                <Text style={styles.sectionSmall}>ASK THE CONTROL ROOM TO GIVE THIS JOB TO ANOTHER CREW</Text>
                <TextInput
                  style={styles.composerInput}
                  value={reassignReason}
                  onChangeText={setReassignReason}
                  placeholder="Reason (e.g. no ladder for this pole, vehicle breakdown)"
                  placeholderTextColor="#9aa8bb"
                  multiline
                  maxLength={500}
                />
                <View style={styles.reassignRow}>
                  <Pressable style={[styles.secondaryBtn, { flex: 1 }]} onPress={() => setReassignOpen(false)} disabled={reassignBusy}>
                    <Text style={styles.secondaryBtnText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={[styles.primaryBtn, { flex: 2 }, (reassignReason.trim().length < 3 || reassignBusy) && { opacity: 0.5 }]} onPress={sendReassign} disabled={reassignReason.trim().length < 3 || reassignBusy}>
                    <Text style={styles.primaryBtnText}>{reassignBusy ? 'Sending…' : 'Send request'}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        )}

        {checklistDone && (
        <View style={styles.assetRow}>
          <Text style={styles.sectionSmall}>ASSET SCAN</Text>
          {assetId ? <Text style={styles.assetValue}>Attached asset: {assetId}</Text> : null}
          {assetDetails ? <Text style={styles.assetValue}>QR details: {JSON.stringify(assetDetails)}</Text> : null}
          <Text style={styles.assetValue}>Saved scans: {assetScans.length}</Text>
          {assetScans.map((scan) => {
            const where = fmtLatLon({ lat: Number(scan.lat), lon: Number(scan.lon) });
            return (
              <View key={scan.id} style={styles.scanRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.scanTitle}>{scan.asset_id || scan.assetId}{scan.pending ? ' · waiting to sync' : ''}</Text>
                  <Text style={styles.messageMeta}>{where ? `Lat/Long ${where}` : 'No position'}{scan.scanned_at ? ` · ${new Date(scan.scanned_at).toLocaleString()}` : ''}</Text>
                </View>
                {where && onShowOnMap ? (
                  <Pressable style={styles.scanMapBtn} onPress={() => onShowOnMap({ lat: Number(scan.lat), lon: Number(scan.lon), title: `Asset ${scan.asset_id || scan.assetId}`, lines: [`Scanned for ${job.id}`] })}>
                    <Text style={styles.scanMapBtnText}>Show on map</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
          <Pressable style={[styles.secondaryBtn, readOnly && { opacity: 0.5 }]} onPress={() => setShowScanner(true)} disabled={assetScanSaving || readOnly}>
            <Text style={styles.secondaryBtnText}>Scan QR asset tag</Text>
          </Pressable>
        </View>
        )}

        {checklistDone && showScanner && (
          <View style={styles.scannerWrap}>
            <QrScanner
              onScan={handleAssetScan}
              onClose={() => setShowScanner(false)}
            />
          </View>
        )}

        {checklistDone && (
        <Pressable style={[styles.secondaryBtn, readOnly && { opacity: 0.5 }]} onPress={takePhoto} disabled={uploading || photoCount >= MAX_JOB_PHOTOS || readOnly}>
          <Text style={styles.secondaryBtnText}>{uploading ? 'Compressing and storing…' : `Open camera · ${PHOTO_STAGE_LABEL[stage]} (${photoCount}/${MAX_JOB_PHOTOS})`}</Text>
        </Pressable>
        )}
        {checklistDone && showPhotoCamera && <PhotoCamera tag={PHOTO_STAGE_LABEL[stage]} onCapture={saveCapturedPhoto} onClose={() => setShowPhotoCamera(false)} />}
        {message ? <Text style={styles.assetValue}>{message}</Text> : null}

        {checklistDone && job.planned && <PlannedOutagePanel job={job} />}
        {plannedMessage ? <Text style={styles.plannedGate}>{plannedMessage}</Text> : null}
        {siteMessage ? (
          <View style={styles.siteBlock}>
            <Text style={styles.siteBlockText}>{siteMessage}</Text>
            <Pressable style={styles.secondaryBtn} onPress={() => onNavigate(job)}>
              <Text style={styles.secondaryBtnText}>Navigate to site</Text>
            </Pressable>
          </View>
        ) : null}
        {checklistDone && job.status === 'On Site' && photoCount < 1 && (
          <View style={styles.checklistLock}>
            <Text style={styles.checklistLockText}>
              Photo required: take at least one site photo to start work. Scanning the asset QR is optional.
            </Text>
          </View>
        )}

        {checklistDone && next && !completionStep && !readOnly && (
          <Pressable
            style={[styles.primaryBtn, job.status === 'On Site' && photoCount < 1 && { opacity: 0.5 }]}
            onPress={requestAdvance}
            disabled={advancing}
          >
            <Text style={styles.primaryBtnText}>
              {advancing ? 'Updating status…' : job.status === 'Pending Acceptance' ? 'Accept task' : `${next} →`}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ProfileScreen({ crew, jobs, onLogout }) {
  const activeJobs = jobs.filter((job) => !isJobDone(job));
  return (
    <View>
      <Text style={styles.title}>My profile</Text>
      <Text style={styles.subtitle}>Crew identity and field assignment details.</Text>
      <View style={styles.profilePanel}>
        <View style={styles.profileAvatar}><Text style={styles.profileAvatarText}>{crew.name?.charAt(5) || 'C'}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.profileName}>{crew.name}</Text>
          <Text style={styles.profileRole}>{crew.role} · {crew.id}</Text>
          <Text style={styles.profileLead}>Lead: {crew.lead || 'Assigned crew lead'}</Text>
        </View>
      </View>
      <View style={styles.profileGrid}>
        <Stat value={crew.shift || 'Day shift'} label="Shift" />
        <Stat value={String(activeJobs.length)} label="Active jobs" />
      </View>
      <View style={styles.profileDetails}>
        <Text style={styles.sectionSmall}>CREW DETAILS</Text>
        <Text style={styles.profileDetailLine}>Skills: {(crew.skills || ['Field operations']).join(', ')}</Text>
        <Text style={styles.profileDetailLine}>Status: Ready for assignment</Text>
        <Text style={styles.profileDetailLine}>Session: Offline capable</Text>
      </View>
      <Pressable style={styles.logoutBtn} onPress={onLogout}>
        <Text style={styles.logoutBtnText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  woCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: 12, backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6ecf3', marginBottom: 12 },
  woCardTodo: { borderColor: '#e0a33a', backgroundColor: '#fff8ec' },
  woCardTitle: { fontSize: 11, fontWeight: '800', color: '#7c8da3', letterSpacing: 0.5 },
  woCardText: { fontSize: 15, fontWeight: '700', color: '#0f1b2d', marginTop: 3 },
  woCardArrow: { fontSize: 26, color: '#1F3864', fontWeight: '700' },
  plannedGate: { color: '#8A4B00', backgroundColor: '#FFF4E5', borderRadius: 10, padding: 10, marginTop: 10, fontSize: 14, fontWeight: '600' },
  loginSafe: { flex: 1, backgroundColor: '#10201d' },
  login: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 48 },
  loginKicker: { color: '#27c7b2', fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  loginTitle: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 40 },
  loginSubtitle: { color: '#a8c0ba', fontSize: 14, marginTop: 8, marginBottom: 36 },
  label: { color: '#d8e7e2', fontSize: 11, fontWeight: '800', letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  error: { color: '#ffb5a8', fontSize: 12, marginTop: 10 },
  signIn: { backgroundColor: '#55d7be', borderRadius: 12, padding: 15, marginTop: 18, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  signInText: { color: '#062b24', fontSize: 14, fontWeight: '800' },
  signInArrow: { color: '#062b24', fontSize: 22, lineHeight: 18 },
  btnOff: { opacity: 0.5 },
  checkboxRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 20 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderWidth: 2, borderColor: '#55d7be' },
  checkboxOn: { backgroundColor: '#55d7be' },
  checkboxLabel: { color: '#d8e7e2', fontSize: 13 },
  demoBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 10 },
  demoBtnText: { color: '#a8c0ba', fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  demoBtnHint: { color: '#5f7b74', fontSize: 11, textAlign: 'center', marginTop: 4 },
  demo: { backgroundColor: 'rgba(255,255,255,.06)', borderRadius: 12, padding: 14, marginTop: 24 },
  demoLabel: { color: '#7f9b94', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  demoText: { color: '#d8e7e2', fontSize: 13, fontWeight: '700', marginTop: 8 },
  demoPassword: { color: '#8eaaa2', fontSize: 12, marginTop: 4 },
  serverRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  serverInput: { flex: 1, color: '#fff', fontSize: 14, borderWidth: 1, borderColor: '#2f4a44', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  serverBtn: { backgroundColor: '#2f4a44', borderRadius: 8, paddingHorizontal: 14, justifyContent: 'center' },
  serverBtnText: { color: '#d8e7e2', fontSize: 13, fontWeight: '800' },
  loginFooter: { color: '#77938c', fontSize: 11, textAlign: 'center', marginTop: 'auto', paddingBottom: 24 },
  safe: { flex: 1, backgroundColor: '#f2f5f9' },
  center: { alignItems: 'center', justifyContent: 'center' },
  locationOffBanner: { backgroundColor: '#B42318', marginHorizontal: 14, marginTop: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10 },
  locationOffTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
  locationOffText: { color: '#FFE4E1', fontSize: 13, marginTop: 2 },
  header: { backgroundColor: '#173355', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 14, borderBottomLeftRadius: 18, borderBottomRightRadius: 18 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerIdentity: { flex: 1, marginRight: 12 },
  actionBar: { flexDirection: 'row', gap: 8, marginTop: 14 },
  action: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 36, paddingHorizontal: 6, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  actionOn: { backgroundColor: 'rgba(39,199,178,0.16)', borderColor: 'rgba(39,199,178,0.45)' },
  actionDanger: { backgroundColor: 'rgba(240,110,98,0.12)', borderColor: 'rgba(240,110,98,0.4)' },
  actionPressed: { opacity: 0.7 },
  actionDisabled: { opacity: 0.5 },
  actionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#6f8aa8', marginRight: 6 },
  actionDotOn: { backgroundColor: '#27c7b2' },
  actionText: { color: '#e3eef9', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  actionTextDanger: { color: '#ffb3ab' },
  actionCount: { minWidth: 17, height: 17, borderRadius: 9, paddingHorizontal: 4, marginLeft: 5, backgroundColor: '#e08a1e', alignItems: 'center', justifyContent: 'center' },
  actionCountText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  historyControls: { flexDirection: 'row', gap: 6 },
  historyButton: { width: 30, height: 30, borderRadius: 8, backgroundColor: '#245675', alignItems: 'center', justifyContent: 'center' },
  historyButtonOff: { opacity: 0.35 },
  historyButtonText: { color: '#b9fff3', fontSize: 25, lineHeight: 25, fontWeight: '500' },
  headerRight: { alignItems: 'flex-end', gap: 6 },
  demoBadge: { backgroundColor: '#5a3fa6', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  demoBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  kicker: { color: '#27c7b2', fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  crewName: { color: '#fff', fontSize: 21, fontWeight: '700', marginTop: 4 },
  role: { color: '#a7bdd6', fontSize: 12, marginTop: 3 },
  pendingBadge: { backgroundColor: '#e08a1e', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  pendingText: { color: '#fff', fontSize: 10, fontWeight: '800' },
  content: { padding: 20, paddingBottom: 100 },
  title: { color: '#0f1b2d', fontSize: 26, fontWeight: '800' },
  subtitle: { color: '#7c8da3', fontSize: 14, marginTop: 5, marginBottom: 20 },
  stats: { flexDirection: 'row', gap: 9, marginBottom: 28 },
  stat: { flex: 1, backgroundColor: '#fff', borderRadius: 12, padding: 13, borderWidth: 1, borderColor: '#e6ecf3' },
  statValue: { color: '#173355', fontSize: 18, fontWeight: '800' },
  statLabel: { color: '#7c8da3', fontSize: 11, marginTop: 4 },
  statActive: { backgroundColor: '#173355', borderColor: '#173355' },
  statValueActive: { color: '#fff' },
  statLabelActive: { color: '#c9d6e6' },
  section: { color: '#7c8da3', fontSize: 11, fontWeight: '800', letterSpacing: 1.5, marginBottom: 11 },
  pendingSection: { backgroundColor: '#fff7ea', borderRadius: 12, borderWidth: 1, borderColor: '#f2d9a8', padding: 14, marginBottom: 24, gap: 10 },
  pendingSectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pendingSectionTitle: { color: '#a8710f', fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  pendingSectionSubtitle: { color: '#8a6a33', fontSize: 12, marginTop: -4 },
  pendingCountPill: { backgroundColor: '#e08a1e', borderRadius: 10, minWidth: 20, height: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 },
  pendingCountPillText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  pendingItemRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  pendingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#e08a1e' },
  pendingItemTitle: { color: '#5a3d10', fontSize: 13, fontWeight: '700' },
  pendingItemMeta: { color: '#8a6a33', fontSize: 11, marginTop: 1 },
  sectionSmall: { color: '#7c8da3', fontSize: 10, fontWeight: '800', letterSpacing: 1.2, marginBottom: 8 },
  card: { backgroundColor: '#fff', borderRadius: 13, flexDirection: 'row', marginBottom: 12, overflow: 'hidden', borderWidth: 1, borderColor: '#e6ecf3' },
  severity: { width: 5 },
  cardBody: { flex: 1, padding: 15 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  jobId: { color: '#7c8da3', fontSize: 11, fontWeight: '700' },
  status: { color: '#33465f', backgroundColor: '#f2f5f9', borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, fontSize: 10, fontWeight: '700' },
  severityBadge: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3, marginTop: 8 },
  severityBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  jobTitle: { color: '#0f1b2d', fontSize: 16, fontWeight: '800', marginTop: 10 },
  address: { color: '#7c8da3', fontSize: 13, marginTop: 4 },
  meta: { color: '#33465f', fontSize: 12, fontWeight: '600', marginTop: 13 },
  planLine: { color: '#33465f', fontSize: 12, fontWeight: '700', marginTop: 6 },
  glimpse: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#1f6feb', marginHorizontal: 14, marginTop: 10, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, elevation: 4, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  glimpseJob: { backgroundColor: '#c2410c' },
  glimpseTitle: { color: '#fff', fontSize: 14, fontWeight: '800' },
  glimpseText: { color: '#eaf2ff', fontSize: 12, marginTop: 2 },
  glimpseClose: { color: '#fff', fontSize: 22, fontWeight: '700', paddingHorizontal: 4 },
  mapNotice: { paddingHorizontal: 14, paddingTop: 8 },
  cancelledDot: { backgroundColor: '#b42318' },
  pendingDismiss: { borderWidth: 1, borderColor: '#d8b06a', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  pendingDismissText: { color: '#8a5a00', fontSize: 12, fontWeight: '800' },
  messageRowOwn: { backgroundColor: '#e8f7f1', borderColor: '#b5e3d2' },
  composer: { gap: 8, marginTop: 6 },
  composerJobs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  composerJob: { borderWidth: 1, borderColor: '#c9d3e0', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: '#fff' },
  composerJobOn: { backgroundColor: '#1F3864', borderColor: '#1F3864' },
  composerJobText: { color: '#1F3864', fontSize: 12, fontWeight: '700' },
  composerJobTextOn: { color: '#fff' },
  composerInput: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#c7d0dc', borderRadius: 8, padding: 10, fontSize: 14, color: '#0f1b2d', minHeight: 60, textAlignVertical: 'top' },
  reassignBox: { gap: 8 },
  reassignRow: { flexDirection: 'row', gap: 8 },
  siteBlock: { backgroundColor: '#fdecea', borderRadius: 10, borderWidth: 1, borderColor: '#f3b8b2', padding: 12, gap: 8 },
  siteBlockText: { color: '#8f2219', fontSize: 13, fontWeight: '700' },
  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#fff', borderRadius: 9, padding: 10, borderWidth: 1, borderColor: '#e6ecf3' },
  scanTitle: { color: '#173355', fontSize: 13, fontWeight: '700' },
  scanMapBtn: { borderWidth: 1, borderColor: '#6b3fa0', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  scanMapBtnText: { color: '#6b3fa0', fontSize: 12, fontWeight: '800' },
  photoCameraTag: { position: 'absolute', left: 10, bottom: 10, color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.35)', textShadowRadius: 2 },
  noticeBanner: { backgroundColor: '#fdecea', borderRadius: 12, borderWidth: 1, borderColor: '#f3b8b2', padding: 14, marginBottom: 16, gap: 6 },
  noticeText: { color: '#8f2219', fontSize: 13, fontWeight: '700' },
  noticeDismiss: { color: '#b0554c', fontSize: 11, fontWeight: '600' },
  empty: { paddingTop: 40 },
  nav: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#e6ecf3', flexDirection: 'row', paddingTop: 10, paddingBottom: 12 },
  navItem: { flex: 1, alignItems: 'center' },
  navText: { color: '#7c8da3', fontSize: 12, fontWeight: '700' },
  navActive: { color: '#0e9f8e' },
  detailSafe: { flex: 1, backgroundColor: '#f2f5f9' },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 18, backgroundColor: '#173355' },
  detailBack: { color: '#b9fff3', fontWeight: '700' },
  detailId: { color: '#fff', fontWeight: '800' },
  detailContent: { padding: 20, gap: 14, paddingBottom: 80 },
  detailStats: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#fff', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e6ecf3' },
  checklistLock: { backgroundColor: '#fff7ea', borderRadius: 10, borderWidth: 1, borderColor: '#f2d9a8', padding: 12 },
  checklistLockText: { color: '#8a6a33', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  secondaryBtn: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#1F3864', borderRadius: 10, padding: 12, alignItems: 'center' },
  secondaryBtnText: { color: '#1F3864', fontWeight: '700' },
  messagesPanel: { backgroundColor: '#eef5fb', borderRadius: 12, padding: 13, gap: 9 },
  messagesHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  messagesClose: { color: '#1F3864', fontSize: 12, fontWeight: '800' },
  messageRow: { backgroundColor: '#fff', borderRadius: 9, padding: 10, borderWidth: 1, borderColor: '#d8e4ef' },
  messageBody: { color: '#243b56', fontSize: 13, lineHeight: 18 },
  messageMeta: { color: '#7c8da3', fontSize: 10, marginTop: 5 },
  assetRow: { gap: 8 },
  assetValue: { color: '#33465f', fontSize: 13, fontWeight: '600' },
  scannerWrap: { minHeight: 560, marginBottom: 12, borderRadius: 12, overflow: 'hidden' },
  photoCamera: { backgroundColor: '#0f1b2d', borderRadius: 12, overflow: 'hidden', padding: 10, gap: 10 },
  photoCameraPreview: { height: 360, borderRadius: 9, overflow: 'hidden' },
  photoCameraError: { color: '#ffb5a8', fontSize: 12, paddingHorizontal: 4 },
  photoCameraActions: { flexDirection: 'row', gap: 9 },
  photoCameraPermission: { backgroundColor: '#eef5fb', borderRadius: 12, padding: 14, gap: 10 },
  primaryBtn: { backgroundColor: '#1F3864', borderRadius: 10, padding: 14, alignItems: 'center' },
  completionSummary: { backgroundColor: '#eafaf1', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#a9e3c4', gap: 4 },
  restoredBox: { marginTop: 12 },
  restoredRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
  restoredChoice: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: '#c9d3e0', alignItems: 'center', backgroundColor: '#fff' },
  restoredChoiceOn: { backgroundColor: '#1F3864', borderColor: '#1F3864' },
  restoredChoiceText: { fontWeight: '600', color: '#1F3864' },
  restoredChoiceTextOn: { color: '#fff' },
  completionSummaryTitle: { color: '#1b7a4a', fontSize: 13, fontWeight: '800' },
  completionSummaryLine: { color: '#2f5d47', fontSize: 12 },
  primaryBtnText: { color: '#fff', fontWeight: '800' },
  offlineBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 14 },
  offlineDot: { width: 8, height: 8, borderRadius: 4 },
  offlineDotOn: { backgroundColor: '#2a9d5c' },
  offlineDotOff: { backgroundColor: '#c7d0dc' },
  offlineBadgeText: { color: '#7c8da3', fontSize: 12, flex: 1 },
  routeAllBtn: { backgroundColor: '#1F3864', borderRadius: 10, padding: 13, alignItems: 'center', marginBottom: 16 },
  routeAllBtnText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  mapPanel: { backgroundColor: '#fff', borderRadius: 12, padding: 12, borderWidth: 1, borderColor: '#e6ecf3' },
  packProgressTrack: { height: 6, borderRadius: 3, backgroundColor: '#e6ecf3', overflow: 'hidden', marginTop: -6, marginBottom: 12 },
  packProgressFill: { height: 6, borderRadius: 3, backgroundColor: '#0e9f8e' },
  mapLegend: { color: '#7c8da3', fontSize: 11, marginTop: 10 },
  mapControls: { flexDirection: 'row', gap: 9, marginTop: 10 },
  mapControlButton: { flex: 1, backgroundColor: '#fff', borderRadius: 9, borderWidth: 1, borderColor: '#d5e0eb', paddingVertical: 10, alignItems: 'center' },
  mapControlText: { color: '#1F3864', fontSize: 12, fontWeight: '800' },
  mapControlDisabled: { color: '#aab6c4' },
  packPauseBtn: { flex: 0, marginBottom: 16 },
  mapSelectedCard: { backgroundColor: '#fff', borderRadius: 12, padding: 14, marginTop: 12, borderWidth: 1, borderColor: '#b9dcd3', gap: 8 },
  mapSelectedTitle: { color: '#173355', fontSize: 15, fontWeight: '800' },
  mapSelectedMeta: { color: '#7c8da3', fontSize: 12 },
  mapGuideText: { color: '#173355', fontSize: 14, fontWeight: '700' },
  mapArrivedText: { color: '#0e9f8e' },
  mapOfflineNote: { backgroundColor: '#fff7e6', borderRadius: 9, borderWidth: 1, borderColor: '#f0c36d', padding: 10, gap: 3 },
  mapOfflineNoteTitle: { color: '#8a5a00', fontSize: 13, fontWeight: '800' },
  mapOfflineNoteText: { color: '#6b5a3a', fontSize: 12 },
  mapEmpty: { color: '#7c8da3', fontSize: 13, marginTop: 16, textAlign: 'center' },
  profilePanel: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: '#fff', borderRadius: 13, padding: 16, borderWidth: 1, borderColor: '#e6ecf3' },
  profileAvatar: { width: 58, height: 58, borderRadius: 18, backgroundColor: '#173355', alignItems: 'center', justifyContent: 'center' },
  profileAvatarText: { color: '#fff', fontSize: 24, fontWeight: '800' },
  profileName: { color: '#0f1b2d', fontSize: 18, fontWeight: '800' },
  profileRole: { color: '#0e9f8e', fontSize: 12, fontWeight: '700', marginTop: 3 },
  profileLead: { color: '#7c8da3', fontSize: 12, marginTop: 5 },
  profileGrid: { flexDirection: 'row', gap: 9, marginTop: 12 },
  profileDetails: { backgroundColor: '#fff', borderRadius: 12, padding: 15, marginTop: 12, borderWidth: 1, borderColor: '#e6ecf3', gap: 10 },
  profileDetailLine: { color: '#33465f', fontSize: 13 },
  logoutBtn: { marginTop: 18, padding: 14, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#efc9c4', backgroundColor: '#fff' },
  logoutBtnText: { color: '#bd3e32', fontWeight: '800' },
});
