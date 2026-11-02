import { useEffect, useRef, useState } from 'react';
import { api, socket } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, timeAgo, hhmm, useLiveRefresh, toast, useDialog, crewBusyText, RowButton } from '../lib/ui.jsx';
import { Drawer, DrawerContent } from '../components/ui/drawer.jsx';
import { currentUser } from '../lib/auth.js';
import { useT, tOr, t as tr } from '../lib/i18n.js';
import { incidentPlanApi } from '../lib/plannedApi.js';
import { fail, PlanApprovalButtons, PlanEditor, StepList, SafetyLog } from '../components/SwitchingPlan.jsx';

// Creating an incident and returning one for correction are control-room
// actions (the API refuses other roles, OMS-03).
const isControlRoom = () => currentUser().roles.some((r) => r === 'oms_operator' || r === 'system_admin');

const SEVS = ['all', 'critical', 'high', 'medium', 'low'];
// 'planned' is a type filter, not a status: planned outages (OMS-01) move
// through their own states (notified, isolating, restoring ...).
const STATS = ['all', 'open', 'dispatched', 'in_progress', 'pending', 'resolved', 'planned'];

export default function Incidents({ openId, focusIncidentId, clearFocus, showOnMap } = {}) {
  const { t } = useT();
  const [inc, setInc] = useState([]);
  const [sev, setSev] = useState('all');
  const [st, setSt] = useState('all');
  const [sel, setSel] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const load = () => api.incidents().then(setInc);
  const refreshSel = () => {
    load();
    if (sel) api.incident(sel.id).then(setSel);
  };
  useEffect(() => { load(); }, []);
      useEffect(() => {
    const idToOpen = openId || focusIncidentId;
    if (idToOpen) {
      api.incident(idToOpen).then(setSel);
      if (clearFocus) clearFocus();
    }
  }, [openId, focusIncidentId]);
  useLiveRefresh(['oms.incident.created', 'oms.incident.updated', 'crew.job.updated'], load);
  useEffect(() => { if (sel) api.incident(sel.id).then(setSel); }, [inc.length]); // eslint-disable-line

  // Deep-link from another screen (currently: Alarms ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¾ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ "view incident").
  // Opens the requested incident once, then clears the request so navigating
  // away and back to Incidents normally doesn't keep re-opening it.
  useEffect(() => {
    if (!focusIncidentId) return;
    api.incident(focusIncidentId).then(setSel).finally(() => clearFocus && clearFocus());
  }, [focusIncidentId]); // eslint-disable-line

  const rows = inc.filter((i) => (sev === 'all' || i.severity === sev)
    && (st === 'all' || (st === 'planned' ? i.type === 'Scheduled' : i.status === st)));

  const open = (i) => api.incident(i.id).then(setSel);

  return (
    <>
      <div className="page-head">
        <div><div className="eyebrow">{t('inc.eyebrow')}</div><h2>{t('inc.title')}</h2>
          <p>{t('inc.intro')}</p></div>
        {isControlRoom() && <button className="btn primary" onClick={() => setShowNew(true)}><Icon name="plus" size={16} /> {t('inc.new')}</button>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {SEVS.map((s) => <button key={s} className={`pill ${sev === s ? 'on' : ''}`} onClick={() => setSev(s)}>{s === 'all' ? t('inc.allSev') : t(`sev.${s}`)}</button>)}
        <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
        {STATS.map((s) => <button key={s} className={`pill ${st === s ? 'on' : ''}`} onClick={() => setSt(s)}>{s === 'all' ? t('inc.allStatus') : s === 'planned' ? t('inc.planned') : t(`st.${s}`)}</button>)}
      </div>

      <div className="card">
        <table>
          <thead><tr>{['id', 'severity', 'type', 'zone', 'feeder', 'customers', 'opened', 'status'].map((c) => <th key={c}>{t(`col.${c}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="click" onClick={() => open(i)}>
                {/* The row click is for the mouse; the ID button is the keyboard / screen-reader way in (WCAG 2.1.1). */}
                <td className="id-cell"><RowButton label={t('inc.open', { id: i.id })} onActivate={() => open(i)}>{i.id}</RowButton></td>
                <td><SevBadge sev={i.severity} /></td>
                <td>{tOr(`type.${i.type}`, i.type)}</td>
                <td>{i.zone}</td>
                <td className="mono" style={{ fontSize: 12 }}>{i.feeder || '-'}</td>
                <td className="mono">{(i.customers || 0).toLocaleString()}</td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(i.opened_at)}</td>
                <td><StatusBadge status={i.status} /><ScadaBadges inc={i} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8}><div className="empty"><span className="disp">{t('inc.nothing')}</span>{t('inc.adjust')}</div></td></tr>}
          </tbody>
        </table>
      </div>

      {sel && <IncidentDrawer inc={sel} onClose={() => setSel(null)} onChange={refreshSel} showOnMap={showOnMap} />}
      {showNew && <NewIncident onClose={() => setShowNew(false)} onCreated={(i) => { setShowNew(false); load(); open(i); }} />}
    </>
  );
}

// OMS-02: SCADA restoration markers.
function ScadaBadges({ inc }) {
  const { t } = useT();
  return (
    <>
      {inc.momentary && <span className="chip chip-merged" style={{ marginLeft: 6 }}>{t('inc.momentary')}</span>}
      {inc.restored_by === 'SCADA' && <span className="chip chip-ok" style={{ marginLeft: 6 }}>{t('inc.restoredScada')}</span>}
    </>
  );
}

function predictionText(p) {
  if (p.method === 'none') return tr('drw.predNone');
  if (p.method === 'cim-trace') return tr('drw.predCim', { n: p.transformers });
  return tr('drw.predFeeder', { n: p.transformers, c: (p.customers_estimate || 0).toLocaleString() });
}

function IncidentDrawer({ inc, onClose, onChange, showOnMap }) {
  useT();
  const [busy, setBusy] = useState(false);
  // vaul neither moves focus in (autoFocus is off by default) nor knows the row that opened it:
  // remember the opener and give focus back on close (WCAG 2.4.3).
  useEffect(() => {
    const opener = document.activeElement;
    return () => { if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus(); };
  }, []);
  const [nearest, setNearest] = useState([]);
  useEffect(() => { api.nearestCrews(inc.id).then(setNearest).catch(() => setNearest([])); }, [inc.id]);
  // OMS-03: the crew's field completion report and lock state, per job.
  const [report, setReport] = useState([]);
  const loadReport = () => api.fieldReport(inc.id).then(setReport).catch(() => setReport([]));
  useEffect(() => { loadReport(); }, [inc.id, inc.status]); // eslint-disable-line
  useLiveRefresh(['crew.job.updated', 'oms.incident.updated'], loadReport);
  const locked = report.some((r) => r.locked);
  const undoUntil = report.map((r) => r.undoUntil).find(Boolean);
  // Return for correction replaces the plain "send crew back" step: it needs
  // a reason and reopens the crew's job (Requires Revisit) instead of
  // leaving it locked as Work Complete.
  const isPlanned = inc.type === 'Scheduled' || inc.source === 'PLANNED';
  const canReturn = inc.status === 'pending' && !isPlanned && isControlRoom() && report.some((r) => r.job.status === 'Work Complete');
  const [returning, setReturning] = useState(false);
  const [reason, setReason] = useState('');
  // Timeline events whose checklist is shown; collapsed again on every open.
  const [expanded, setExpanded] = useState({});
  const doReturn = async () => {
    if (!reason.trim()) { toast(tr('drw.sayWhat'), 'err'); return; }
    setBusy(true);
    try {
      await api.returnForCorrection(inc.id, reason.trim());
      toast(tr('drw.returned', { id: inc.id }));
      setReturning(false); setReason(''); onChange(); loadReport();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const doStatus = async (status) => {
    setBusy(true);
    try { await api.setStatus(inc.id, status); toast(`${inc.id} -> ${tOr(`st.${status}`, status.replace('_', ' '))}`); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const doAssign = async (crewId) => {
    setBusy(true);
    try { await api.assign(inc.id, crewId, 'Normal'); toast(tr('drw.assigned')); onChange(); loadRequests(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  // A crew asking to be taken off this incident's job (crew app).
  const [requests, setRequests] = useState([]);
  const loadRequests = () => api.reassignRequests().then((all) => setRequests(all.filter((r) => r.incident_id === inc.id))).catch(() => setRequests([]));
  useEffect(() => { loadRequests(); }, [inc.id]); // eslint-disable-line
  useLiveRefresh(['crew.job.updated', 'oms.incident.updated'], loadRequests);
  const doDismissRequest = async (r) => {
    const note = window.prompt(tr('drw.declinePrompt', { crew: r.crew_id }), '');
    if (note === null) return;
    setBusy(true);
    try { await api.dismissReassignRequest(r.id, note); toast(tr('drw.declined')); loadRequests(); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const [ertInput, setErtInput] = useState('');
  const doSetErt = async () => {
    if (!ertInput) { toast(tr('drw.pickDate'), 'err'); return; }
    setBusy(true);
    try {
      await api.setErt(inc.id, new Date(ertInput).toISOString());
      toast(tr('drw.ertUpdated'));
      onChange();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  // handleOnly (not dismissible={false}): no drag on the content, so the ETA datetime input still works,
  // while Escape and an outside click close the drawer (WCAG 2.1.1).
  return (
    <Drawer direction="right" open={true} onOpenChange={(open) => { if (!open) onClose(); }} handleOnly
      autoFocus /* eslint-disable-line jsx-a11y/no-autofocus -- vaul prop: move focus into the dialog it opens */>
      <DrawerContent aria-label={tr('drw.details', { id: inc.id })} style={{ width: 'min(440px, 94vw)', height: '100vh', borderRadius: 0 }}>
        <div className="drawer-h">
          <div>
            <div className="id-cell" style={{ fontSize: 13 }}>{inc.id}</div>
            <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600, marginTop: 3 }}>{tOr(`type.${inc.type}`, inc.type)}</div>
            <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}><SevBadge sev={inc.severity} /><StatusBadge status={inc.status} /><ScadaBadges inc={inc} /><LockBadge locked={locked} undoUntil={undoUntil} /></div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label={tr('inc.close')}><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">
          <div className="kv-row"><span className="k">{tr('col.zone')}</span><span className="v">{inc.zone}</span></div>
          <div className="kv-row"><span className="k">{tr('col.feeder')}</span><span className="v mono">{inc.feeder || '-'}</span></div>
          {inc.tripped_equipment && (
            <div className="kv-row"><span className="k">{tr('inc.tripped')}</span><span className="v">{inc.tripped_equipment.name || tr('inc.unnamed')} <span className="mono">({inc.tripped_equipment.cim_mrid})</span></span></div>
          )}
          <div className="kv-row"><span className="k">{tr('inc.fCustomers')}</span><span className="v mono">{(inc.customers || 0).toLocaleString()}</span></div>
          <div className="kv-row"><span className="k">{tr('inc.fCause')}</span><span className="v">{inc.cause}</span></div>
          <div className="kv-row"><span className="k">{tr('drw.source')}</span><span className="v mono">{inc.source}</span></div>
          {inc.prediction && (
            <div className="kv-row" title={inc.prediction.basis}>
              <span className="k">{tr('drw.predicted')}</span>
              <span className="v">{predictionText(inc.prediction)}</span>
            </div>
          )}
          {(inc.open_trip_tags || []).length > 0 && (
            <div className="kv-row"><span className="k">{tr('drw.devicesOpen')}</span><span className="v mono" style={{ fontSize: 12 }}>{inc.open_trip_tags.join(', ')}</span></div>
          )}
          <div className="kv-row"><span className="k">{tr('col.opened')}</span><span className="v mono">{hhmm(inc.opened_at)} - {timeAgo(inc.opened_at)}</span></div>
          <div className="kv-row"><span className="k">{tr('drw.slaDue')}</span><span className="v mono">{hhmm(inc.sla_due_at)}</span></div>

          <div className="kv-row">
            <span className="k">{tr('drw.estRest')}</span>
            <span className="v mono">{inc.ert ? hhmm(inc.ert) : tr('drw.notSet')}</span>
          </div>
          <div className="kv-row" style={{ alignItems: 'center', gap: 8 }}>
            <input
              type="datetime-local"
              aria-label={tr('drw.ertAria')}
              value={ertInput}
              onChange={(e) => setErtInput(e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }}
            />
            <button className="btn sm" disabled={busy} onClick={doSetErt}>{tr('drw.updEta')}</button>
          </div>

          <div style={{ margin: '18px 0 8px' }} className="eyebrow">{tr('drw.advance')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(inc.nextStates || []).filter((s) => !(canReturn && s === 'in_progress')).map((s) => (
              <button key={s} className={`btn sm ${s === 'cancelled' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => doStatus(s)}>
                {s === 'cancelled' ? tr('drw.cancel') : (inc.status === 'pending' && s === 'resolved') ? tr('drw.accept') : (inc.status === 'pending' && s === 'in_progress') ? tr('drw.deny') : `-> ${tOr(`st.${s}`, inc.stateLabels?.[s] || s)}`}
              </button>
            ))}
            {!inc.nextStates?.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{inc.plannedOutageId
              ? tr('drw.plannedNote')
              : tr('drw.terminal')}</span>}
            {canReturn && !returning && (
              <button className="btn sm danger" disabled={busy} onClick={() => setReturning(true)}>{tr('drw.rfc')}</button>
            )}
          </div>
          {canReturn && returning && (
            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              <label className="eyebrow" htmlFor="rfc-reason">{tr('drw.rfcLabel')}</label>
              <textarea id="rfc-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus // eslint-disable-line jsx-a11y/no-autofocus -- opened by the user's own click
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm danger" disabled={busy || !reason.trim()} onClick={doReturn}>{tr('drw.returnCrew')}</button>
                <button className="btn sm" disabled={busy} onClick={() => { setReturning(false); setReason(''); }}>{tr('drw.cancel')}</button>
              </div>
            </div>
          )}

          <ReassignRequestPanel requests={requests} nearest={nearest} busy={busy} onAssign={doAssign} onDismiss={doDismissRequest} />
          <CrewJobsPanel report={report} />
          <FieldReportPanel report={report} />
          {!isPlanned && isControlRoom() && <IncidentSwitchingPlan inc={inc} onChange={onChange} />}

          {!inc.crew_id && ['open', 'dispatched'].includes(inc.status) && (
            <>
              <div style={{ margin: '18px 0 8px' }} className="eyebrow">{tr('drw.assignCrew')}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {nearest.map((c) => (
                  <button key={c.id} className="btn sm" disabled={busy} onClick={() => doAssign(c.id)}>
                    {c.name} - {c.meters_away < 1000 ? `${Math.round(c.meters_away)} m` : `${(c.meters_away / 1000).toFixed(1)} km`}{crewBusyText(c)}
                  </button>
                ))}
                {!nearest.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{tr('drw.noCrews')}</span>}
              </div>
            </>
          )}

          <div style={{ margin: '20px 0 10px' }} className="eyebrow">{tr('drw.timeline')}</div>
          <ul className="timeline">
            {(inc.events || []).map((e) => {
              const { text, items } = eventChecklist(e, report);
              const isOpen = !!expanded[e.id];
              return (
                <li key={e.id} className={e.actor === 'SCADA' ? 'scada' : e.actor_role === 'field_crew' || e.actor === 'Crew' ? 'crew' : ''}>
                  <span className="node" />
                  <div className="k">{e.actor} - {e.kind}</div>
                  <div className="n">
                    {text}
                    {items && (
                      <button type="button" className="caret" aria-expanded={isOpen} onClick={() => setExpanded((x) => ({ ...x, [e.id]: !x[e.id] }))}>
                        {isOpen ? '▾' : '▸'} {tr(items.length === 1 ? 'drw.item1' : 'drw.items', { n: items.length })}
                      </button>
                    )}
                  </div>
                  {items && isOpen && (
                    <ul className="sub">
                      {items.map((x, i) => (
                        <li key={i} className={x.checked ? 'ok' : 'no'}>
                          <span className="mark">{x.checked ? '✓' : '✗'}</span>{x.label}
                          {x.at && <span className="t">{hhmm(x.at)}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="t">{hhmm(e.ts)}</div>
                </li>
              );
            })}
          </ul>
          <MessagePanel incidentId={inc.id} />
          {inc.feeder && <FeederManagerSms incident={inc} />}
          <PhotoPanel incidentId={inc.id} />
          <AssetScanPanel incidentId={inc.id} showOnMap={showOnMap} />
        </div>
      </DrawerContent>
    </Drawer>
  );
}

// OMS-05: the fault incident's own switching plan -- the same editor, step
// list, approval buttons and safety log as a planned outage's
// (components/SwitchingPlan.jsx). The server decides what a step does to
// the incident: no permits, and the last restore step moves it to Pending
// Verification at most; resolving stays with the crew's completion.
const PLAN_TOPICS = ['oms.switching.confirmed', 'oms.switching.rejected', 'oms.incident.updated'];
function IncidentSwitchingPlan({ inc, onChange }) {
  useT();
  const [view, setView] = useState(null);
  const [log, setLog] = useState([]);
  const [crews, setCrews] = useState([]);
  const [tab, setTab] = useState('plan');
  const [starting, setStarting] = useState(false);
  const load = () => Promise.all([incidentPlanApi.get(inc.id), incidentPlanApi.safetyLog(inc.id)])
    .then(([v, l]) => { setView(v); setLog(l); }).catch(fail);
  useEffect(() => { load(); api.crews().then(setCrews).catch(() => {}); }, [inc.id]); // eslint-disable-line
  useLiveRefresh(PLAN_TOPICS, load);
  if (!view) return null;
  const { plan, steps } = view;
  // No plan to show, and none can be started on a finished incident.
  if (!plan && ['resolved', 'closed', 'cancelled'].includes(inc.status)) return null;

  // Every action reloads from the server afterwards, as on Planned outages.
  const act = async (fn, ok) => {
    try { await fn(); if (ok) toast(ok); } catch (e) { fail(e); }
    load(); onChange();
  };
  const ask = (q) => { const v = window.prompt(q); return v && v.trim() ? v.trim() : null; };

  return (
    <>
      <div style={{ margin: '18px 0 8px' }} className="eyebrow">{tr('po.tabPlan')}</div>
      {!plan && !starting ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{tr('inc.noPlan')}</span>
          <button className="btn sm" onClick={() => setStarting(true)}>{tr('inc.startPlan')}</button>
        </div>
      ) : (
        <>
          {plan && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              <PlanApprovalButtons plan={plan} steps={steps} act={act}
                onApprove={() => incidentPlanApi.approve(inc.id)} onUnapprove={() => incidentPlanApi.unapprove(inc.id)} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, borderBottom: '1px solid var(--line)', marginBottom: 12 }}>
            {[['plan', tr('po.tabPlan')], ['log', tr('po.tabLog', { n: log.length })]].map(([k, label]) => (
              <button key={k} className="btn sm" style={{ borderBottom: tab === k ? '2px solid var(--navy)' : undefined, borderRadius: '6px 6px 0 0' }} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === 'plan' && (plan?.state === 'approved'
            ? <StepList plan={plan} steps={steps} act={act} ask={ask} />
            : (
              // The editor's columns are wider than the drawer: scroll, don't
              // squeeze (without the min width its device/location fields
              // collapse to ~20 px).
              <div style={{ overflowX: 'auto' }}>
                <div style={{ minWidth: 660 }}>
                  <PlanEditor plan={plan} steps={steps} crews={crews} defaultCrew={inc.crew_id || ''}
                    onDraft={(body) => incidentPlanApi.draftFromTrace(inc.id, body)} onSave={(s) => incidentPlanApi.saveSteps(inc.id, s)}
                    onSaved={() => { setStarting(false); load(); onChange(); }} />
                </div>
              </div>
            ))}
          {tab === 'log' && <SafetyLog log={log} />}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {tr('inc.planNote')}
          </div>
        </>
      )}
    </>
  );
}

// The checklist behind a timeline event, if it has one: { text, items }.
// A 'checklist' event (pre-work priority checklist) carries it in its note:
// a summary line, a newline, then the items as JSON. A completion-form event
// takes it from that form in the field report (same job, same submitted time).
function eventChecklist(e, report) {
  const note = e.note || '';
  if (e.kind === 'checklist') {
    const cut = note.indexOf('\n');
    if (cut < 0) return { text: note, items: null };
    try {
      const items = JSON.parse(note.slice(cut + 1));
      return { text: note.slice(0, cut), items: Array.isArray(items) && items.length ? items : null };
    } catch {
      return { text: note.slice(0, cut), items: null };
    }
  }
  const m = /^Field completion report submitted for job (\S+?)(,|$)/.exec(note);
  if (m) {
    const form = report.find((r) => r.job.id === m[1])?.completions.find((c) => Date.parse(c.submitted_at) === Date.parse(e.ts));
    if (Array.isArray(form?.checklist) && form.checklist.length) return { text: note, items: form.checklist };
  }
  return { text: note, items: null };
}

// Lock state of the incident's crew job (OMS-03): while the crew can still
// undo, and once its completion is locked.
function LockBadge({ locked, undoUntil }) {
  useT();
  // Re-render the moment the undo window ends, so an open drawer switches to
  // "Locked" instead of still offering an undo time in the past.
  const [, setTick] = useState(0);
  const until = undoUntil ? new Date(undoUntil).getTime() : 0;
  useEffect(() => {
    if (!until || until <= Date.now()) return undefined;
    const t = setTimeout(() => setTick((n) => n + 1), until - Date.now() + 50);
    return () => clearTimeout(t);
  }, [until]);
  if (until && until <= Date.now()) return <span className="chip chip-ok" title={tr('drw.lockOver')}>{tr('drw.locked')}</span>;
  if (undoUntil) return <span className="chip chip-minor" title={tr('drw.canReopen')}>{tr('drw.undoUntil', { t: hhmm(undoUntil) })}</span>;
  if (locked) return <span className="chip chip-ok" title={tr('drw.lockNo')}>{tr('drw.locked')}</span>;
  return null;
}

function NotAppliedChip({ reason }) {
  useT();
  return <span className="chip chip-major" style={{ marginLeft: 6 }} title={tr('drw.naTitle')}>{tr('drw.notApplied', { r: reason })}</span>;
}

const RESTORED_LABEL = { yes: 'Yes', partial: 'Partly', no: 'No' };

// Did the assigned crew get the job? Received = the crew's phone downloaded
// it; Opened = the crew opened the job screen (crew app, first time only).
function CrewJobsPanel({ report }) {
  useT();
  const live = report.filter((r) => r.job.crew_id && !['Work Complete', 'Cancelled', 'Closed'].includes(r.job.status));
  if (!live.length) return null;
  return (
    <div style={{ margin: '18px 0 8px' }}>
      <div className="eyebrow">{tr('drw.crewJob')}</div>
      {live.map(({ job }) => (
        <div key={job.id} style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 10px', margin: '8px 0', fontSize: 13, display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b className="mono">{job.id} - {job.crew_id}</b><span>{tOr(`drw.job.${job.status}`, job.status)}</span></div>
          <div>
            {job.delivered_at
              ? <span className="chip chip-ok">{tr('drw.received', { t: hhmm(job.delivered_at) })}</span>
              : <span className="chip chip-major" title={tr('drw.notRecvTitle')}>{tr('drw.notRecv')}</span>}
            {' '}
            {job.opened_at
              ? <span className="chip chip-ok">{tr('drw.openedBy', { t: hhmm(job.opened_at) })}</span>
              : job.delivered_at ? <span className="chip chip-minor">{tr('drw.notOpened')}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// Open crew requests to hand this incident's job to another crew. Granting
// one = assigning another crew (the server then moves even a started job).
function ReassignRequestPanel({ requests, nearest, busy, onAssign, onDismiss }) {
  useT();
  const open = requests.filter((r) => r.status === 'open');
  if (!open.length) return null;
  return (
    <div style={{ margin: '18px 0 8px', border: '1px solid #f0b37e', background: '#fff6ec', borderRadius: 8, padding: '10px 12px' }}>
      {open.map((r) => {
        const others = nearest.filter((c) => c.id !== r.crew_id);
        return (
          <div key={r.id} style={{ display: 'grid', gap: 8 }}>
            <div className="eyebrow" style={{ color: '#9a4b00' }}>{tr('drw.reqBy', { c: r.crew_name || r.crew_id, t: hhmm(r.created_at) })}</div>
            <div style={{ fontSize: 13.5 }}><b className="mono">{r.job_id}</b> ({tOr(`drw.job.${r.job_status}`, r.job_status)}): "{r.reason}"</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>{tr('drw.giveTo')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {others.map((c) => (
                <button key={c.id} className="btn sm primary" disabled={busy} onClick={() => onAssign(c.id)}>
                  {c.name} - {c.meters_away < 1000 ? `${Math.round(c.meters_away)} m` : `${(c.meters_away / 1000).toFixed(1)} km`}{crewBusyText(c)}
                </button>
              ))}
              {!others.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{tr('drw.noOther')}</span>}
              <button className="btn sm danger" disabled={busy} onClick={() => onDismiss(r)}>{tr('drw.decline')}</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Fault diagnosis answer; "Other" shows the reason the crew typed.
const diagText = (d, key) => (d?.[key] === 'Other' && d[`${key}Other`] ? `${tr('drw.other')}: ${d[`${key}Other`]}` : d?.[key]);

// The crew's completion form for each job of the incident (newest form
// first), plus anything the crew sent after the job was locked.
function FieldReportPanel({ report }) {
  useT();
  const jobs = report.filter((r) => r.completions.length || r.locked || r.undoUntil || r.notApplied.photos.length || r.notApplied.scans.length);
  if (!jobs.length) return null;
  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">{tr('drw.fieldReport')}</div>
      {jobs.map((r) => {
        const c = r.completions[0];
        const parts = Array.isArray(c?.parts_used) ? c.parts_used : [];
        const late = r.notApplied.photos.length + r.notApplied.scans.length;
        return (
          <div key={r.job.id} style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 10px', margin: '8px 0', fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <b className="mono">{r.job.id} - {r.job.crew_id || tr('drw.unassigned')}</b>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{tOr(`drw.job.${r.job.status}`, r.job.status)}<LockBadge locked={r.locked} undoUntil={r.undoUntil} /></span>
            </div>
            {!c && <div style={{ opacity: 0.6, marginTop: 4 }}>{tr('drw.noForm')}</div>}
            {c && (
              <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                {c.diagnosis?.symptom && <div><span style={{ opacity: 0.6 }}>{tr('drw.symptom')}</span> {diagText(c.diagnosis, 'symptom')}</div>}
                {c.diagnosis && <div><span style={{ opacity: 0.6 }}>{tr('drw.diagnosis')}</span> {diagText(c.diagnosis, 'cause') || '-'}{c.diagnosis.action ? ` - ${diagText(c.diagnosis, 'action')}` : ''}</div>}
                {c.diagnosis?.remarks && <div><span style={{ opacity: 0.6 }}>{tr('drw.remarks')}</span> {c.diagnosis.remarks}</div>}
                <div><span style={{ opacity: 0.6 }}>{tr('drw.parts')}</span> {parts.length ? parts.map((x) => `${x.name} x${x.qty}`).join(', ') : tr('drw.none')}</div>
                <div><span style={{ opacity: 0.6 }}>{tr('drw.supplyRest')}</span> {RESTORED_LABEL[c.restored] ? tr(`drw.rest.${c.restored}`) : tr('drw.notStated')}</div>
                {c.sign_off && <div><span style={{ opacity: 0.6 }}>{tr('drw.signedBy')}</span> {c.sign_off.name || '-'}{c.sign_off.signedAt ? tr('drw.at', { t: hhmm(c.sign_off.signedAt) }) : ''}</div>}
                <div style={{ opacity: 0.6 }}>{tr('drw.submitted', { t: hhmm(c.submitted_at) })}{c.submitted_by ? tr('drw.by', { u: c.submitted_by }) : ''}{r.completions.length > 1 ? tr('drw.nForms', { n: r.completions.length }) : ''}</div>
              </div>
            )}
            {late > 0 && <div style={{ marginTop: 6 }}><NotAppliedChip reason={tr('drw.jobLocked')} /> {tr('drw.lateItems', { n: late })}</div>}
          </div>
        );
      })}
    </div>
  );
}

function NewIncident({ onClose, onCreated }) {
  const { t } = useT();
  const [f, setF] = useState({ zone: '', severity: 'high', type: 'Power Outage', feeder: '', customers: 100, cause: 'Unknown' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const dlg = useRef(null);
  useDialog(dlg, onClose);
  const submit = async () => {
    if (!f.zone) { toast(t('inc.zoneRequired'), 'err'); return; }
    setBusy(true);
    try { const i = await api.createIncident({ ...f, customers: Number(f.customers) }); toast(t('inc.created')); onCreated(i); }
    catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  const field = (label, node) => <label style={{ display: 'block', marginBottom: 12 }}><div className="eyebrow" style={{ marginBottom: 5 }}>{label}</div>{node}</label>;
  const inp = { width: '100%', padding: '9px 11px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13.5 };

  return (
    <>
      {/* Mouse-only backdrop; keyboard users close via Escape or the Close button. */}
      <div className="drawer-mask" aria-hidden="true" onClick={onClose} />
      <aside ref={dlg} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-label={t('inc.new')}>
        <div className="drawer-h">
          <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600 }}>{t('inc.new')}</div>
          <button className="iconbtn" aria-label={t('inc.close')} onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">
          {field(t('inc.fZone'), <select style={inp} value={f.zone} onChange={set('zone')}>
  <option value="">{t('inc.fSelectZone')}</option>
  {['Mayapur', 'Bhoopatwala', 'Industrial Area', 'Jwalapur-I', 'Kankhal-2', 'Dehradun Central', 'Clement Town, Dehradun', 'Ballupur, Dehradun', 'Jwalapur, Haridwar'].map((z) => <option key={z} value={z}>{z}</option>)}
</select>)}
          {field(t('inc.fSeverity'), <select style={inp} value={f.severity} onChange={set('severity')}>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s} value={s}>{t(`sev.${s}`)}</option>)}</select>)}
          {field(t('inc.fType'), <select style={inp} value={f.type} onChange={set('type')}>{['Power Outage', 'Partial Power'].map((s) => <option key={s} value={s}>{t(`type.${s}`)}</option>)}</select>)}
          {field(t('inc.fFeeder'), <input style={inp} value={f.feeder} onChange={set('feeder')} placeholder="FDR-SE01-F02" />)}
          {field(t('inc.fCustomers'), <input style={inp} type="number" value={f.customers} onChange={set('customers')} />)}
          {field(t('inc.fCause'), <input style={inp} value={f.cause} onChange={set('cause')} />)}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy} onClick={submit}>{t('inc.create')}</button>
        </div>
      </aside>
    </>
  );
}  
function MessagePanel({ incidentId }) {
  useT();
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.messages(incidentId).then(setMsgs).catch(() => setMsgs([]));
  useEffect(() => { load(); }, [incidentId]); // eslint-disable-line
  // New messages (from the crew app or another operator) appear as they
  // arrive; a socket reconnect reloads whatever was missed while it was down.
  useEffect(() => {
    const h = (m) => { if (m?.incident_id === incidentId) load(); };
    socket.on('oms.message.posted', h);
    socket.on('connect', load);
    return () => { socket.off('oms.message.posted', h); socket.off('connect', load); };
  }, [incidentId]); // eslint-disable-line
  // Keep the newest message in view.
  const listRef = useRef(null);
  const lastId = msgs[msgs.length - 1]?.id;
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [lastId]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await api.postMessage(incidentId, text.trim()); setText(''); await load(); }
    catch { toast(tr('drw.sendFail')); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">{tr('drw.messages')}</div>
      <div ref={listRef} style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' }}>
        {msgs.length === 0 && <div style={{ fontSize: 13, opacity: 0.6 }}>{tr('drw.noMsgs')}</div>}
        {msgs.map((m) => (
          <div key={m.id} style={{ background: m.sender_role === 'field_crew' ? '#fff4e0' : '#f2f5f9', borderRadius: 8, padding: '8px 10px', borderLeft: m.sender_role === 'field_crew' ? '3px solid #e08a1e' : 'none' }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
              {m.sender_role === 'field_crew' ? tr('drw.crewSender', { s: m.sender }) : `${m.sender} - ${m.sender_role}`} - {hhmm(m.ts)}
            </div>
            <div style={{ fontSize: 14 }}>{m.body}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          aria-label={tr('drw.msgCrew')}
          placeholder={tr('drw.msgCrewPh')}
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }}
        />
        <button onClick={send} disabled={busy} style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#12325a', color: '#fff', cursor: 'pointer' }}>
          {tr('drw.send')}
        </button>
      </div>
    </div>
  );
}

// One SMS to the manager of this incident's feeder (Admin -> Feeder managers).
// Blank message = the server's standard status update.
function FeederManagerSms({ incident }) {
  useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const r = await api.smsFeederManager(incident.id, text.trim());
      toast(tr(r.status === 'failed' ? 'drw.smsFailed' : 'drw.smsSent', { r: r.recipient }), r.status === 'failed' ? 'err' : 'ok');
      setText('');
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  return (
    <div style={{ margin: '14px 0 0' }}>
      <div className="eyebrow">{tr('drw.fm', { f: incident.feeder })}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && send()} maxLength={500}
          aria-label={tr('drw.fmAria', { f: incident.feeder })}
          placeholder={tr('drw.fmPh')} style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }} />
        <button onClick={send} disabled={busy} style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#12325a', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' }}>
          {busy ? tr('drw.sending') : tr('drw.smsMgr')}
        </button>
      </div>
    </div>
  );
}

// Equipment the crew scanned on site (QR on poles, transformers, meters).
// asset_details is whatever the QR code carried, if it was JSON.
function AssetScanPanel({ incidentId, showOnMap }) {
  useT();
  const [scans, setScans] = useState([]);
  const load = () => api.assetScans(incidentId).then(setScans).catch(() => setScans([]));
  useEffect(() => { load(); }, [incidentId]); // eslint-disable-line
  useLiveRefresh(['crew.job.updated'], load);

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">{tr('drw.scans', { n: scans.length })}</div>
      {!scans.length && <div style={{ fontSize: 13, opacity: 0.6, margin: '10px 0' }}>{tr('drw.noScans')}</div>}
      <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
        {scans.map((s) => {
          const details = typeof s.asset_details === 'string' ? JSON.parse(s.asset_details) : (s.asset_details || {});
          const entries = Object.entries(details).filter(([, v]) => v != null && typeof v !== 'object');
          return (
            <div key={s.id} style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b className="mono">{s.asset_id || s.raw_value}{s.not_applied_reason && <NotAppliedChip reason={s.not_applied_reason} />}</b>
                <span style={{ opacity: 0.7 }}>{s.crew_id || tr('drw.unknownCrew')} - {hhmm(s.scanned_at)}</span>
              </div>
              {entries.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 12px', opacity: 0.85 }}>
                  {entries.map(([k, v]) => <span key={k}><span style={{ opacity: 0.6 }}>{k}:</span> {String(v)}</span>)}
                </div>
              )}
              {Number.isFinite(s.lat) && Number.isFinite(s.lon) && (
                <div style={{ fontSize: 12, marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mono">{tr('drw.latlon', { a: s.lat.toFixed(6), b: s.lon.toFixed(6) })}</span>
                  {showOnMap && <button className="btn sm" onClick={() => showOnMap({ kind: 'scan', id: s.id, lat: s.lat, lon: s.lon })}>{tr('drw.showMap')}</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const STAGE_LABEL = { work_started: 'Work started', work_finished: 'Work finished' };

function PhotoPanel({ incidentId }) {
  useT();
  const stage = (s) => (STAGE_LABEL[s] ? tr(`drw.stage.${s}`) : '');
  const [photos, setPhotos] = useState([]);
  const [openPhoto, setOpenPhoto] = useState(null);
  const [thumbs, setThumbs] = useState({});

  const load = () => api.photos(incidentId).then((list) => {
    setPhotos(list);
    list.forEach((p) => {
      if (!thumbs[p.id]) {
        api.photoDetail(p.id).then((full) => {
          setThumbs((t) => ({ ...t, [p.id]: full.data_url }));
        }).catch(() => {});
      }
    });
  }).catch(() => setPhotos([]));
  useEffect(() => { load(); }, [incidentId]); // eslint-disable-line
  useLiveRefresh(['crew.job.updated'], load);

  const openFull = (p) => {
    if (thumbs[p.id]) { setOpenPhoto({ ...p, data_url: thumbs[p.id] }); return; }
    api.photoDetail(p.id).then((full) => setOpenPhoto(full)).catch(() => toast(tr('drw.photoFail')));
  };
  const viewer = useRef(null);
  useDialog(viewer, openPhoto ? () => setOpenPhoto(null) : null);
  const photoLabel = (p) => {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
    return tr('drw.takenBy', { w: m.technicianName || p.technician_id || tr('drw.unknownCrewLc'), t: hhmm(p.ts) });
  };

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">{tr('drw.photos', { n: photos.length })}</div>
      {!photos.length && <div style={{ fontSize: 13, opacity: 0.6, margin: '10px 0' }}>{tr('drw.noPhotos')}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        {photos.map((p) => {
          const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => openFull(p)}
              aria-label={`${tr('drw.openPhoto')} ${STAGE_LABEL[meta.stage] ? stage(meta.stage) + ', ' : ''}${photoLabel(p)}${p.not_applied_reason ? tr('drw.lateNa') : ''}`}
              style={{ padding: 0, width: 84, height: 84, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: '#f2f5f9', position: 'relative', border: '1px solid var(--line-2)' }}
              title={`${STAGE_LABEL[meta.stage] ? stage(meta.stage) + ' - ' : ''}${meta.technicianName || p.technician_id || tr('drw.unknown')} - ${hhmm(p.ts)}${Number.isFinite(p.lat) ? ` - ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : ''}${p.not_applied_reason ? tr('drw.naParen', { r: p.not_applied_reason }) : ''}`}
            >
              {STAGE_LABEL[meta.stage] && <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 1, background: 'rgba(15,27,45,.55)', color: '#fff', fontSize: 9, fontWeight: 700, textAlign: 'center', padding: '1px 0' }}>{stage(meta.stage)}</span>}
              {p.not_applied_reason && <span className="chip chip-major" title={tr('drw.naKept', { r: p.not_applied_reason })} style={{ position: 'absolute', left: 2, top: 2, zIndex: 1, padding: '0 5px', fontSize: 10 }}>{tr('drw.late')}</span>}
              {thumbs[p.id] ? (
                <img src={thumbs[p.id]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.6 }}>...</div>
              )}
            </button>
          );
        })}
      </div>
      {openPhoto && (
        // Backdrop click is mouse-only; keyboard users close via Escape or the Close button.
        // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2300, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={(e) => { if (e.target === e.currentTarget) setOpenPhoto(null); }}>
          <div ref={viewer} tabIndex={-1} role="dialog" aria-modal="true" aria-label={tr('drw.jobPhoto')} style={{ background: '#fff', borderRadius: 10, padding: 16, maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto' }}>
            <img src={openPhoto.data_url} alt={photoLabel(openPhoto)} style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', borderRadius: 6, marginBottom: 10 }} />
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <b>{(() => { const m = typeof openPhoto.metadata === 'string' ? JSON.parse(openPhoto.metadata) : (openPhoto.metadata || {}); return m.technicianName || openPhoto.technician_id || tr('drw.unknownCrew'); })()}</b>
              {' - '}{hhmm(openPhoto.ts)}
              {(() => { const m = typeof openPhoto.metadata === 'string' ? JSON.parse(openPhoto.metadata) : (openPhoto.metadata || {}); return STAGE_LABEL[m.stage] ? <span className="chip chip-soft" style={{ marginLeft: 8 }}>{stage(m.stage)}</span> : null; })()}
              {Number.isFinite(openPhoto.lat) && Number.isFinite(openPhoto.lon) && <div className="mono" style={{ marginTop: 4 }}>{tr('drw.latlon', { a: openPhoto.lat.toFixed(6), b: openPhoto.lon.toFixed(6) })}</div>}
              {openPhoto.note && <div style={{ marginTop: 4, opacity: 0.8 }}>{openPhoto.note}</div>}
            </div>
            <button className="btn sm" onClick={() => setOpenPhoto(null)} autoFocus /* eslint-disable-line jsx-a11y/no-autofocus -- opened by the user's own click */>{tr('inc.close')}</button>
          </div>
        </div>
      )}
    </div>
  );
}