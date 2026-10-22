import { useEffect, useState } from 'react';
import { api, socket } from '../lib/api.js';
import { Icon, SevBadge, StatusBadge, timeAgo, hhmm, useLiveRefresh, toast, crewBusyText } from '../lib/ui.jsx';
import { Drawer, DrawerContent } from '../components/ui/drawer.jsx';
import { currentUser } from '../lib/auth.js';

// Creating an incident and returning one for correction are control-room
// actions (the API refuses other roles, OMS-03).
const isControlRoom = () => currentUser().roles.some((r) => r === 'oms_operator' || r === 'system_admin');

const SEVS = ['all', 'critical', 'high', 'medium', 'low'];
// 'planned' is a type filter, not a status: planned outages (OMS-01) move
// through their own states (notified, isolating, restoring ...).
const STATS = ['all', 'open', 'dispatched', 'in_progress', 'pending', 'resolved', 'planned'];

export default function Incidents({ openId, focusIncidentId, clearFocus, showOnMap } = {}) {
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
        <div><div className="eyebrow">Lifecycle</div><h2>Incidents</h2>
          <p>Detect, classify, dispatch and restore - every transition audited.</p></div>
        {isControlRoom() && <button className="btn primary" onClick={() => setShowNew(true)}><Icon name="plus" size={16} /> New incident</button>}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {SEVS.map((s) => <button key={s} className={`pill ${sev === s ? 'on' : ''}`} onClick={() => setSev(s)}>{s === 'all' ? 'All severities' : s}</button>)}
        <span style={{ width: 1, background: 'var(--line)', margin: '0 4px' }} />
        {STATS.map((s) => <button key={s} className={`pill ${st === s ? 'on' : ''}`} onClick={() => setSt(s)}>{s === 'all' ? 'All statuses' : s === 'planned' ? 'Planned outages' : s.replace('_', ' ')}</button>)}
      </div>

      <div className="card">
        <table>
          <thead><tr><th>ID</th><th>Severity</th><th>Type</th><th>Zone</th><th>Feeder</th><th>Customers</th><th>Opened</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="click" onClick={() => open(i)}>
                <td className="id-cell">{i.id}</td>
                <td><SevBadge sev={i.severity} /></td>
                <td>{i.type}</td>
                <td>{i.zone}</td>
                <td className="mono" style={{ fontSize: 12 }}>{i.feeder || '-'}</td>
                <td className="mono">{(i.customers || 0).toLocaleString()}</td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(i.opened_at)}</td>
                <td><StatusBadge status={i.status} /><ScadaBadges inc={i} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8}><div className="empty"><span className="disp">Nothing matches</span>Adjust the filters above.</div></td></tr>}
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
  return (
    <>
      {inc.momentary && <span className="chip chip-merged" style={{ marginLeft: 6 }}>Momentary</span>}
      {inc.restored_by === 'SCADA' && <span className="chip chip-ok" style={{ marginLeft: 6 }}>Restored by SCADA</span>}
    </>
  );
}

function predictionText(p) {
  if (p.method === 'none') return 'Not available - feeder not in network model';
  if (p.method === 'cim-trace') return `${p.transformers} transformers (CIM trace)`;
  return `${p.transformers} transformers, ~${(p.customers_estimate || 0).toLocaleString()} customers (feeder-level)`;
}

function IncidentDrawer({ inc, onClose, onChange, showOnMap }) {
  const [busy, setBusy] = useState(false);
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
    if (!reason.trim()) { toast('Say what needs correcting', 'err'); return; }
    setBusy(true);
    try {
      await api.returnForCorrection(inc.id, reason.trim());
      toast(`${inc.id} returned to the crew for correction`);
      setReturning(false); setReason(''); onChange(); loadReport();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  const doStatus = async (status) => {
    setBusy(true);
    try { await api.setStatus(inc.id, status); toast(`${inc.id} -> ${status.replace('_', ' ')}`); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const doAssign = async (crewId) => {
    setBusy(true);
    try { await api.assign(inc.id, crewId, 'Normal'); toast('Crew assigned'); onChange(); loadRequests(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  // A crew asking to be taken off this incident's job (crew app).
  const [requests, setRequests] = useState([]);
  const loadRequests = () => api.reassignRequests().then((all) => setRequests(all.filter((r) => r.incident_id === inc.id))).catch(() => setRequests([]));
  useEffect(() => { loadRequests(); }, [inc.id]); // eslint-disable-line
  useLiveRefresh(['crew.job.updated', 'oms.incident.updated'], loadRequests);
  const doDismissRequest = async (r) => {
    const note = window.prompt(`Decline ${r.crew_id}'s request? Optional note for the crew:`, '');
    if (note === null) return;
    setBusy(true);
    try { await api.dismissReassignRequest(r.id, note); toast('Request declined - the crew was told to continue'); loadRequests(); onChange(); }
    catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };
  const [ertInput, setErtInput] = useState('');
  const doSetErt = async () => {
    if (!ertInput) { toast('Pick a date/time first', 'err'); return; }
    setBusy(true);
    try {
      await api.setErt(inc.id, new Date(ertInput).toISOString());
      toast('Restoration estimate updated - customers notified if it moved significantly');
      onChange();
    } catch (e) { toast(e.message, 'err'); } finally { setBusy(false); }
  };

  return (
    <Drawer direction="right" open={true} onOpenChange={(open) => { if (!open) onClose(); }} dismissible={false}>
      <DrawerContent aria-label={`Incident ${inc.id} details`} style={{ width: 'min(440px, 94vw)', height: '100vh', borderRadius: 0 }}>
        <div className="drawer-h">
          <div>
            <div className="id-cell" style={{ fontSize: 13 }}>{inc.id}</div>
            <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600, marginTop: 3 }}>{inc.type}</div>
            <div style={{ display: 'flex', gap: 7, marginTop: 8, flexWrap: 'wrap' }}><SevBadge sev={inc.severity} /><StatusBadge status={inc.status} /><ScadaBadges inc={inc} /><LockBadge locked={locked} undoUntil={undoUntil} /></div>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">
          <div className="kv-row"><span className="k">Zone</span><span className="v">{inc.zone}</span></div>
          <div className="kv-row"><span className="k">Feeder</span><span className="v mono">{inc.feeder || '-'}</span></div>
          <div className="kv-row"><span className="k">Customers affected</span><span className="v mono">{(inc.customers || 0).toLocaleString()}</span></div>
          <div className="kv-row"><span className="k">Cause</span><span className="v">{inc.cause}</span></div>
          <div className="kv-row"><span className="k">Source</span><span className="v mono">{inc.source}</span></div>
          {inc.prediction && (
            <div className="kv-row" title={inc.prediction.basis}>
              <span className="k">Predicted downstream</span>
              <span className="v">{predictionText(inc.prediction)}</span>
            </div>
          )}
          {(inc.open_trip_tags || []).length > 0 && (
            <div className="kv-row"><span className="k">Devices still open</span><span className="v mono" style={{ fontSize: 12 }}>{inc.open_trip_tags.join(', ')}</span></div>
          )}
          <div className="kv-row"><span className="k">Opened</span><span className="v mono">{hhmm(inc.opened_at)} - {timeAgo(inc.opened_at)}</span></div>
          <div className="kv-row"><span className="k">SLA due</span><span className="v mono">{hhmm(inc.sla_due_at)}</span></div>

          <div className="kv-row">
            <span className="k">Est. restoration</span>
            <span className="v mono">{inc.ert ? hhmm(inc.ert) : 'Not set'}</span>
          </div>
          <div className="kv-row" style={{ alignItems: 'center', gap: 8 }}>
            <input
              type="datetime-local"
              aria-label="Estimated restoration date and time"
              value={ertInput}
              onChange={(e) => setErtInput(e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }}
            />
            <button className="btn sm" disabled={busy} onClick={doSetErt}>Update ETA</button>
          </div>

          <div style={{ margin: '18px 0 8px' }} className="eyebrow">Advance lifecycle</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(inc.nextStates || []).filter((s) => !(canReturn && s === 'in_progress')).map((s) => (
              <button key={s} className={`btn sm ${s === 'cancelled' ? 'danger' : 'primary'}`} disabled={busy} onClick={() => doStatus(s)}>
                {s === 'cancelled' ? 'Cancel' : (inc.status === 'pending' && s === 'resolved') ? 'Accept - verified restored' : (inc.status === 'pending' && s === 'in_progress') ? 'Deny - send crew back' : `-> ${(inc.stateLabels?.[s] || s)}`}
              </button>
            ))}
            {!inc.nextStates?.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{inc.plannedOutageId
              ? 'Planned outage - its status follows the switching plan and work permits. Manage it in Planned outages.'
              : 'Terminal state - no further transitions.'}</span>}
            {canReturn && !returning && (
              <button className="btn sm danger" disabled={busy} onClick={() => setReturning(true)}>Return for correction</button>
            )}
          </div>
          {canReturn && returning && (
            <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
              <label className="eyebrow" htmlFor="rfc-reason">What needs correcting? (required, the crew sees it on the timeline)</label>
              <textarea id="rfc-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus
                style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13 }} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn sm danger" disabled={busy || !reason.trim()} onClick={doReturn}>Return to crew</button>
                <button className="btn sm" disabled={busy} onClick={() => { setReturning(false); setReason(''); }}>Cancel</button>
              </div>
            </div>
          )}

          <ReassignRequestPanel requests={requests} nearest={nearest} busy={busy} onAssign={doAssign} onDismiss={doDismissRequest} />
          <CrewJobsPanel report={report} />
          <FieldReportPanel report={report} />

          {!inc.crew_id && ['open', 'dispatched'].includes(inc.status) && (
            <>
              <div style={{ margin: '18px 0 8px' }} className="eyebrow">Assign crew - free crews first, then nearest</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {nearest.map((c) => (
                  <button key={c.id} className="btn sm" disabled={busy} onClick={() => doAssign(c.id)}>
                    {c.name} - {c.meters_away < 1000 ? `${Math.round(c.meters_away)} m` : `${(c.meters_away / 1000).toFixed(1)} km`}{crewBusyText(c)}
                  </button>
                ))}
                {!nearest.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No crews on shift right now.</span>}
              </div>
            </>
          )}

          <div style={{ margin: '20px 0 10px' }} className="eyebrow">Status timeline</div>
          <ul className="timeline">
            {(inc.events || []).map((e) => {
              const { text, items } = eventChecklist(e, report);
              const isOpen = !!expanded[e.id];
              return (
                <li key={e.id} className={e.actor === 'SCADA' ? 'scada' : e.actor === 'Crew' ? 'crew' : ''}>
                  <span className="node" />
                  <div className="k">{e.actor} - {e.kind}</div>
                  <div className="n">
                    {text}
                    {items && (
                      <button type="button" className="caret" aria-expanded={isOpen} onClick={() => setExpanded((x) => ({ ...x, [e.id]: !x[e.id] }))}>
                        {isOpen ? '▾' : '▸'} {items.length} item{items.length === 1 ? '' : 's'}
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
        </div>
          <PhotoPanel incidentId={inc.id} />
          <AssetScanPanel incidentId={inc.id} showOnMap={showOnMap} />
      </DrawerContent>
    </Drawer>
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
  // Re-render the moment the undo window ends, so an open drawer switches to
  // "Locked" instead of still offering an undo time in the past.
  const [, setTick] = useState(0);
  const until = undoUntil ? new Date(undoUntil).getTime() : 0;
  useEffect(() => {
    if (!until || until <= Date.now()) return undefined;
    const t = setTimeout(() => setTick((n) => n + 1), until - Date.now() + 50);
    return () => clearTimeout(t);
  }, [until]);
  if (until && until <= Date.now()) return <span className="chip chip-ok" title="The undo window is over; use Return for correction">Locked</span>;
  if (undoUntil) return <span className="chip chip-minor" title="The crew can still reopen the job">Crew can undo until {hhmm(undoUntil)}</span>;
  if (locked) return <span className="chip chip-ok" title="Crew writes are no longer applied; use Return for correction">Locked</span>;
  return null;
}

function NotAppliedChip({ reason }) {
  return <span className="chip chip-major" style={{ marginLeft: 6 }} title="Arrived after the job was locked; kept for the record, not applied">Not applied - {reason}</span>;
}

const RESTORED_LABEL = { yes: 'Yes', partial: 'Partly', no: 'No' };

// Did the assigned crew get the job? Received = the crew's phone downloaded
// it; Opened = the crew opened the job screen (crew app, first time only).
function CrewJobsPanel({ report }) {
  const live = report.filter((r) => r.job.crew_id && !['Work Complete', 'Cancelled', 'Closed'].includes(r.job.status));
  if (!live.length) return null;
  return (
    <div style={{ margin: '18px 0 8px' }}>
      <div className="eyebrow">Crew job</div>
      {live.map(({ job }) => (
        <div key={job.id} style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 10px', margin: '8px 0', fontSize: 13, display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b className="mono">{job.id} - {job.crew_id}</b><span>{job.status}</span></div>
          <div>
            {job.delivered_at
              ? <span className="chip chip-ok">Received on phone {hhmm(job.delivered_at)}</span>
              : <span className="chip chip-major" title="The crew's phone has not downloaded this job yet (app closed, no signal, or not signed in)">Not yet received by the crew's phone</span>}
            {' '}
            {job.opened_at
              ? <span className="chip chip-ok">Opened by crew {hhmm(job.opened_at)}</span>
              : job.delivered_at ? <span className="chip chip-minor">Not opened yet</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// Open crew requests to hand this incident's job to another crew. Granting
// one = assigning another crew (the server then moves even a started job).
function ReassignRequestPanel({ requests, nearest, busy, onAssign, onDismiss }) {
  const open = requests.filter((r) => r.status === 'open');
  if (!open.length) return null;
  return (
    <div style={{ margin: '18px 0 8px', border: '1px solid #f0b37e', background: '#fff6ec', borderRadius: 8, padding: '10px 12px' }}>
      {open.map((r) => {
        const others = nearest.filter((c) => c.id !== r.crew_id);
        return (
          <div key={r.id} style={{ display: 'grid', gap: 8 }}>
            <div className="eyebrow" style={{ color: '#9a4b00' }}>Reassignment requested by {r.crew_name || r.crew_id} - {hhmm(r.created_at)}</div>
            <div style={{ fontSize: 13.5 }}><b className="mono">{r.job_id}</b> ({r.job_status}): "{r.reason}"</div>
            <div style={{ fontSize: 12, opacity: 0.75 }}>Give the job to:</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {others.map((c) => (
                <button key={c.id} className="btn sm primary" disabled={busy} onClick={() => onAssign(c.id)}>
                  {c.name} - {c.meters_away < 1000 ? `${Math.round(c.meters_away)} m` : `${(c.meters_away / 1000).toFixed(1)} km`}{crewBusyText(c)}
                </button>
              ))}
              {!others.length && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>No other crew on shift right now.</span>}
              <button className="btn sm danger" disabled={busy} onClick={() => onDismiss(r)}>Decline - crew continues</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Fault diagnosis answer; "Other" shows the reason the crew typed.
const diagText = (d, key) => (d?.[key] === 'Other' && d[`${key}Other`] ? `Other: ${d[`${key}Other`]}` : d?.[key]);

// The crew's completion form for each job of the incident (newest form
// first), plus anything the crew sent after the job was locked.
function FieldReportPanel({ report }) {
  const jobs = report.filter((r) => r.completions.length || r.locked || r.undoUntil || r.notApplied.photos.length || r.notApplied.scans.length);
  if (!jobs.length) return null;
  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">Field completion report</div>
      {jobs.map((r) => {
        const c = r.completions[0];
        const parts = Array.isArray(c?.parts_used) ? c.parts_used : [];
        const late = r.notApplied.photos.length + r.notApplied.scans.length;
        return (
          <div key={r.job.id} style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 10px', margin: '8px 0', fontSize: 13 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <b className="mono">{r.job.id} - {r.job.crew_id || 'unassigned'}</b>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{r.job.status}<LockBadge locked={r.locked} undoUntil={r.undoUntil} /></span>
            </div>
            {!c && <div style={{ opacity: 0.6, marginTop: 4 }}>No completion form sent (the crew app sends it from the next app version).</div>}
            {c && (
              <div style={{ display: 'grid', gap: 3, marginTop: 6 }}>
                {c.diagnosis?.symptom && <div><span style={{ opacity: 0.6 }}>Symptom:</span> {diagText(c.diagnosis, 'symptom')}</div>}
                {c.diagnosis && <div><span style={{ opacity: 0.6 }}>Diagnosis:</span> {diagText(c.diagnosis, 'cause') || '-'}{c.diagnosis.action ? ` - ${diagText(c.diagnosis, 'action')}` : ''}</div>}
                {c.diagnosis?.remarks && <div><span style={{ opacity: 0.6 }}>Remarks:</span> {c.diagnosis.remarks}</div>}
                <div><span style={{ opacity: 0.6 }}>Parts used:</span> {parts.length ? parts.map((x) => `${x.name} x${x.qty}`).join(', ') : 'none'}</div>
                <div><span style={{ opacity: 0.6 }}>Supply restored:</span> {RESTORED_LABEL[c.restored] || 'not stated'}</div>
                {c.sign_off && <div><span style={{ opacity: 0.6 }}>Signed off by:</span> {c.sign_off.name || '-'}{c.sign_off.signedAt ? ` at ${hhmm(c.sign_off.signedAt)}` : ''}</div>}
                <div style={{ opacity: 0.6 }}>Submitted {hhmm(c.submitted_at)}{c.submitted_by ? ` by ${c.submitted_by}` : ''}{r.completions.length > 1 ? ` - ${r.completions.length} forms (job was reopened)` : ''}</div>
              </div>
            )}
            {late > 0 && <div style={{ marginTop: 6 }}><NotAppliedChip reason="job locked" /> {late} item(s) arrived after the lock - see photos and scans below.</div>}
          </div>
        );
      })}
    </div>
  );
}

function NewIncident({ onClose, onCreated }) {
  const [f, setF] = useState({ zone: '', severity: 'high', type: 'Power Outage', feeder: '', customers: 100, cause: 'Unknown' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.zone) { toast('Zone is required', 'err'); return; }
    setBusy(true);
    try { const i = await api.createIncident({ ...f, customers: Number(f.customers) }); toast('Incident created'); onCreated(i); }
    catch (e) { toast(e.message, 'err'); setBusy(false); }
  };
  const field = (label, node) => <label style={{ display: 'block', marginBottom: 12 }}><div className="eyebrow" style={{ marginBottom: 5 }}>{label}</div>{node}</label>;
  const inp = { width: '100%', padding: '9px 11px', border: '1px solid var(--line-2)', borderRadius: 7, fontFamily: 'var(--ui)', fontSize: 13.5 };

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="New incident">
        <div className="drawer-h">
          <div style={{ fontFamily: 'var(--disp)', fontSize: 18, fontWeight: 600 }}>New incident</div>
          <button className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        <div className="drawer-b">
          {field('Zone *', <select style={inp} value={f.zone} onChange={set('zone')}>
  <option value="">Select a zone...</option>
  {['Mayapur', 'Bhoopatwala', 'Industrial Area', 'Jwalapur-I', 'Kankhal-2', 'Dehradun Central', 'Clement Town, Dehradun', 'Ballupur, Dehradun', 'Jwalapur, Haridwar'].map((z) => <option key={z} value={z}>{z}</option>)}
</select>)}
          {field('Severity', <select style={inp} value={f.severity} onChange={set('severity')}>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s}>{s}</option>)}</select>)}
          {field('Type', <select style={inp} value={f.type} onChange={set('type')}>{['Power Outage', 'Partial Power'].map((s) => <option key={s}>{s}</option>)}</select>)}
          {field('Feeder', <input style={inp} value={f.feeder} onChange={set('feeder')} placeholder="FDR-SE01-F02" />)}
          {field('Customers affected', <input style={inp} type="number" value={f.customers} onChange={set('customers')} />)}
          {field('Cause', <input style={inp} value={f.cause} onChange={set('cause')} />)}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy} onClick={submit}>Create incident</button>
        </div>
      </aside>
    </>
  );
}  
function MessagePanel({ incidentId }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api.messages(incidentId).then(setMsgs).catch(() => setMsgs([]));
  useEffect(() => { load(); }, [incidentId]); // eslint-disable-line
  // New messages (from the crew app or another operator) appear as they arrive.
  useEffect(() => {
    const h = (m) => { if (m?.incident_id === incidentId) load(); };
    socket.on('oms.message.posted', h);
    return () => socket.off('oms.message.posted', h);
  }, [incidentId]); // eslint-disable-line

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await api.postMessage(incidentId, text.trim()); setText(''); await load(); }
    catch { toast('Could not send message'); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">Crew and dispatcher messages</div>
      <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, margin: '10px 0' }}>
        {msgs.length === 0 && <div style={{ fontSize: 13, opacity: 0.6 }}>No messages yet.</div>}
        {msgs.map((m) => (
          <div key={m.id} style={{ background: m.sender_role === 'field_crew' ? '#fff4e0' : '#f2f5f9', borderRadius: 8, padding: '8px 10px', borderLeft: m.sender_role === 'field_crew' ? '3px solid #e08a1e' : 'none' }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 2 }}>
              {m.sender_role === 'field_crew' ? `Crew (${m.sender})` : `${m.sender} - ${m.sender_role}`} - {hhmm(m.ts)}
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
          aria-label="Message the crew"
          placeholder="Message the crew..."
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #ccc' }}
        />
        <button onClick={send} disabled={busy} style={{ padding: '8px 14px', borderRadius: 8, border: 0, background: '#12325a', color: '#fff', cursor: 'pointer' }}>
          Send
        </button>
      </div>
    </div>
  );
}

// Equipment the crew scanned on site (QR on poles, transformers, meters).
// asset_details is whatever the QR code carried, if it was JSON.
function AssetScanPanel({ incidentId, showOnMap }) {
  const [scans, setScans] = useState([]);
  const load = () => api.assetScans(incidentId).then(setScans).catch(() => setScans([]));
  useEffect(() => { load(); }, [incidentId]); // eslint-disable-line
  useLiveRefresh(['crew.job.updated'], load);

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">Asset scans ({scans.length})</div>
      {!scans.length && <div style={{ fontSize: 13, opacity: 0.6, margin: '10px 0' }}>No assets scanned yet.</div>}
      <div style={{ display: 'grid', gap: 8, margin: '10px 0' }}>
        {scans.map((s) => {
          const details = typeof s.asset_details === 'string' ? JSON.parse(s.asset_details) : (s.asset_details || {});
          const entries = Object.entries(details).filter(([, v]) => v != null && typeof v !== 'object');
          return (
            <div key={s.id} style={{ border: '1px solid var(--line-2)', borderRadius: 8, padding: '8px 10px', fontSize: 13 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <b className="mono">{s.asset_id || s.raw_value}{s.not_applied_reason && <NotAppliedChip reason={s.not_applied_reason} />}</b>
                <span style={{ opacity: 0.7 }}>{s.crew_id || 'Unknown crew'} - {hhmm(s.scanned_at)}</span>
              </div>
              {entries.length > 0 && (
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: '2px 12px', opacity: 0.85 }}>
                  {entries.map(([k, v]) => <span key={k}><span style={{ opacity: 0.6 }}>{k}:</span> {String(v)}</span>)}
                </div>
              )}
              {Number.isFinite(s.lat) && Number.isFinite(s.lon) && (
                <div style={{ fontSize: 12, marginTop: 4, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mono">Lat {s.lat.toFixed(6)}, Long {s.lon.toFixed(6)}</span>
                  {showOnMap && <button className="btn sm" onClick={() => showOnMap({ kind: 'scan', id: s.id, lat: s.lat, lon: s.lon })}>Show on network map</button>}
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
    api.photoDetail(p.id).then((full) => setOpenPhoto(full)).catch(() => toast('Could not load photo'));
  };

  return (
    <div style={{ margin: '20px 0 10px' }}>
      <div className="eyebrow">Job photos ({photos.length})</div>
      {!photos.length && <div style={{ fontSize: 13, opacity: 0.6, margin: '10px 0' }}>No photos yet.</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        {photos.map((p) => {
          const meta = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : (p.metadata || {});
          return (
            <div
              key={p.id}
              onClick={() => openFull(p)}
              style={{ width: 84, height: 84, borderRadius: 8, overflow: 'hidden', cursor: 'pointer', background: '#f2f5f9', position: 'relative', border: '1px solid var(--line-2)' }}
              title={`${STAGE_LABEL[meta.stage] ? STAGE_LABEL[meta.stage] + ' - ' : ''}${meta.technicianName || p.technician_id || 'Unknown'} - ${hhmm(p.ts)}${Number.isFinite(p.lat) ? ` - ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : ''}${p.not_applied_reason ? ` - not applied (${p.not_applied_reason})` : ''}`}
            >
              {STAGE_LABEL[meta.stage] && <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 1, background: 'rgba(15,27,45,.55)', color: '#fff', fontSize: 9, fontWeight: 700, textAlign: 'center', padding: '1px 0' }}>{STAGE_LABEL[meta.stage]}</span>}
              {p.not_applied_reason && <span className="chip chip-major" title={`Not applied - ${p.not_applied_reason}; kept for the record`} style={{ position: 'absolute', left: 2, top: 2, zIndex: 1, padding: '0 5px', fontSize: 10 }}>Late</span>}
              {thumbs[p.id] ? (
                <img src={thumbs[p.id]} alt="Job photo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, opacity: 0.6 }}>...</div>
              )}
            </div>
          );
        })}
      </div>
      {openPhoto && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2300, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => setOpenPhoto(null)}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 16, maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <img src={openPhoto.data_url} alt="Job photo full size" style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', borderRadius: 6, marginBottom: 10 }} />
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <b>{(() => { const m = typeof openPhoto.metadata === 'string' ? JSON.parse(openPhoto.metadata) : (openPhoto.metadata || {}); return m.technicianName || openPhoto.technician_id || 'Unknown crew'; })()}</b>
              {' - '}{hhmm(openPhoto.ts)}
              {(() => { const m = typeof openPhoto.metadata === 'string' ? JSON.parse(openPhoto.metadata) : (openPhoto.metadata || {}); return STAGE_LABEL[m.stage] ? <span className="chip chip-soft" style={{ marginLeft: 8 }}>{STAGE_LABEL[m.stage]}</span> : null; })()}
              {Number.isFinite(openPhoto.lat) && Number.isFinite(openPhoto.lon) && <div className="mono" style={{ marginTop: 4 }}>Lat {openPhoto.lat.toFixed(6)}, Long {openPhoto.lon.toFixed(6)}</div>}
              {openPhoto.note && <div style={{ marginTop: 4, opacity: 0.8 }}>{openPhoto.note}</div>}
            </div>
            <button className="btn sm" onClick={() => setOpenPhoto(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}