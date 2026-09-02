import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import ActionSearchBar from './kokonutui/action-search-bar.jsx';
import { api } from '../lib/api.js';

const SEV_COLOR = { critical: '#c73a3a', high: '#c8811a', medium: '#2f6fed', low: '#1f8a5b' };

export default function IncidentSearch({ onOpen }) {
  const [actions, setActions] = useState([]);

  useEffect(() => {
    api.incidents().then((list) => {
      setActions(
        list.slice(0, 30).map((i) => ({
          id: i.id,
          label: `${i.zone} - ${i.id}`,
          icon: <Zap size={15} color={SEV_COLOR[i.severity] || '#94a3b8'} />,
          description: i.type,
          end: i.status.replace('_', ' '),
        }))
      );
    });
  }, []);

  return (
    <ActionSearchBar
      actions={actions}
      onSelect={(action) => {
        const inc = { id: action.id };
        if (onOpen) onOpen(inc);
      }}
    />
  );
}