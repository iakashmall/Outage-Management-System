import { useEffect, useState } from "react";
import "./app.css";
import { keycloak, logout as kcLogout, myCrewId } from "./lib/auth.js";
import { getMyJobs, updateJobStatus } from "./lib/api.js";

/* =========================================================
   DEMO DATA
========================================================= */

const CREWS = [
  {
    id: "C001",
    name: "Crew Alpha-3",
    lead: "Rajesh Kumar",
    role: "Crew Lead",
    shift: "06:00–18:00",
    skills: ["HV", "Underground"],
  },
  {
    id: "C002",
    name: "Crew Beta-1",
    lead: "Amit Sharma",
    role: "Field Technician",
    shift: "06:00–18:00",
    skills: ["MV", "Recloser"],
  },
  {
    id: "C003",
    name: "Crew Gamma-2",
    lead: "Priya Singh",
    role: "Field Technician",
    shift: "06:00–18:00",
    skills: ["HV", "Transformer"],
  },
  {
    id: "C004",
    name: "Crew Delta-4",
    lead: "Suresh Patel",
    role: "Crew Lead",
    shift: "18:00–06:00",
    skills: ["MV", "Fuse"],
  },
  {
    id: "C005",
    name: "Crew Echo-1",
    lead: "Meena Rao",
    role: "Field Technician",
    shift: "18:00–06:00",
    skills: ["MV", "LV"],
  },
];

const CREW_STATUSES = {
  "Crew Alpha-3": "On Site",
  "Crew Beta-1": "En Route",
  "Crew Gamma-2": "Available",
  "Crew Delta-4": "On Site",
  "Crew Echo-1": "Offline",
};

const DEMO_ACCOUNTS = [
  {
    email: "admin@oms-demo.com",
    password: "Admin@123",
    role: "leader",
    label: "Operations Admin",
    crewId: "C001",
  },
  {
    email: "crew@oms-demo.com",
    password: "Crew@123",
    role: "crew",
    label: "Field Crew",
    crewId: "C003",
  },
];

const DEMO_OMS_JOBS = [
  {
    id: "JOB-1005",
    title: "Pending Line Inspection",
    address: "Mussoorie Road, Dehradun",
    feeder: "FDR-17",
    severity: "High",
    priority: "Urgent",
    customers: 386,
    status: "Pending Acceptance",
    distance: "1.6 km",
    eta: "6 min",
    assignedCrewId: "C003",
    assignedDistance: "1.6 km",
  },
  {
    id: "JOB-1001",
    title: "Transformer Failure",
    address: "Rajpur Road, Dehradun",
    feeder: "FDR-12",
    severity: "Critical",
    priority: "Urgent",
    customers: 842,
    status: "Acknowledged",
    distance: "2.4 km",
    eta: "7 min",
  },
  {
    id: "JOB-1002",
    title: "Line Fault",
    address: "Haridwar Road, Rishikesh",
    feeder: "FDR-08",
    severity: "High",
    priority: "Urgent",
    customers: 531,
    status: "En Route",
    distance: "5.8 km",
    eta: "14 min",
  },
  {
    id: "JOB-1003",
    title: "Fuse Failure",
    address: "Clock Tower, Dehradun",
    feeder: "FDR-03",
    severity: "Medium",
    priority: "Normal",
    customers: 214,
    status: "On Site",
    distance: "8.2 km",
    eta: "21 min",
  },
  {
    id: "JOB-1004",
    title: "Cable Fault",
        address: "Prem Nagar, Dehradun",
        feeder: "FDR-21",
        severity: "Low",
    priority: "Planned",
    customers: 93,
    status: "Work Started",
    distance: "11.4 km",
    eta: "28 min",
  },
];

const OMS_JOBS_URL = import.meta.env.VITE_OMS_JOBS_URL;

function severityClass(severity) {
  const normalized = String(severity ?? "Medium").toLowerCase();
  return ["critical", "high", "medium", "low"].includes(normalized)
    ? normalized
    : "medium";
}

function normalizeOmsJob(job) {
  return {
    id: job.id ?? job.jobId,
    title: job.title ?? job.name ?? "Priority outage",
    address: job.address ?? job.location ?? "Location unavailable",
    feeder: job.feeder ?? job.feederId ?? "—",
    severity: job.severity ?? "Medium",
    priority: job.priority ?? "Urgent",
    customers: job.customers ?? job.affectedCustomers ?? 0,
    status: job.status ?? "Pending Acceptance",
    distance: job.distance ?? (job.distanceKm ? `${job.distanceKm} km` : "—"),
    eta: job.eta ?? "—",
    assignedCrewId: job.assignedCrewId ?? job.crewId ?? null,
    assignedDistance: job.assignedDistance ?? job.distance ?? "Nearest available",
  };
}

/* =========================================================
   MAIN APP
========================================================= */

export default function App() {
  const [role, setRole] = useState(null);
  const [crew, setCrew] = useState(null);
    const [jobs, setJobs] = useState([]);
  const [omsSource, setOmsSource] = useState("oms");

  useEffect(() => {
    getMyJobs().then(setJobs).catch((e) => {
      console.error("Could not load jobs", e);
      setOmsSource("demo");
    });
  }, []);

  const updateJob = (id, changes) => {
    setJobs((current) =>
      current.map((job) =>
        job.id === id ? { ...job, ...changes } : job
      )
    );
  };

  // Authentication is handled by Keycloak (see main.jsx). Once we're here,
  // the user is logged in. Pick their crew from the token's crew_id and
  // decide crew-vs-leader from that crew's role.
  useEffect(() => {
    const id = myCrewId();
    const found = CREWS.find((item) => item.id === id) || CREWS[2]; // fallback C003
    setCrew(found);
    setRole(found.role === "Crew Lead" ? "leader" : "crew");
  }, []);

  if (!role || !crew) {
    return <div className="app-shell"><div className="login-screen"><p style={{padding:24}}>Loading your workspace…</p></div></div>;
  }

  /* -------------------------------------------------------
     CREW APP
  ------------------------------------------------------- */

  if (role === "crew") {
    return (
      <CrewLayout
        crew={crew}
        jobs={jobs}
        onUpdateJob={updateJob}
        omsSource={omsSource}
        onLogout={() => kcLogout()}
      />
    );
  }

  /* -------------------------------------------------------
     LEADER APP
  ------------------------------------------------------- */

  return (
    <LeaderLayout
      crew={crew}
      jobs={jobs}
      omsSource={omsSource}
      onLogout={() => {
        setCrew(null);
        setRole(null);
      }}
    />
  );
}

/* =========================================================
   ROLE SELECTION
========================================================= */

function GeneralLogin({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();
    const account = DEMO_ACCOUNTS.find(
      (item) =>
        item.email === email.trim().toLowerCase() &&
        item.password === password
    );

    if (!account) {
      setError("The email or password is incorrect.");
      return;
    }

    setError("");
    onLogin(account);
  };

  return (
    <div className="app-shell">
      <div className="login-screen">
        <div className="brand">
          <div className="brand-icon">⚡</div>

          <div>
            <h1>
              OMS <span>Crew</span>
            </h1>

            <p>Outage Management System</p>
          </div>
        </div>

        <div className="login-card">
          <h2>Sign in to OMS</h2>

          <p className="muted">
            Enter your work email to continue to the right workspace.
          </p>

          <form className="email-login-form" onSubmit={handleSubmit}>
            <label htmlFor="login-email">Work email</label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                setError("");
              }}
              placeholder="you@company.com"
              autoComplete="email"
              autoFocus
              required
            />
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setError("");
              }}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
            {error && <p className="login-error">{error}</p>}
            <button className="email-submit" type="submit">
              Continue <span>→</span>
            </button>
          </form>

          <div className="demo-accounts">
            <span>Demonstration accounts</span>
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.email}
                type="button"
                onClick={() => {
                  setEmail(account.email);
                  setPassword(account.password);
                  setError("");
                }}
              >
                <strong>{account.label}</strong>
                <small>{account.email} · {account.password}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="login-footer">
          Ganga Corridor · UPCL Field Operations
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   CREW LOGIN
========================================================= */

function CrewLogin({ onSelect, onBack }) {
  const technicians = CREWS.filter(
    (crew) => crew.role === "Field Technician"
  );

  return (
    <div className="app-shell">
      <div className="login-screen">
        <button className="back-button" onClick={onBack}>
          ← Back
        </button>

        <div className="brand">
          <div className="brand-icon">⚡</div>

          <div>
            <h1>
              OMS <span>Crew</span>
            </h1>

            <p>Field Technician Login</p>
          </div>
        </div>

        <div className="login-card">
          <h2>Select your crew</h2>

          <p className="muted">
            Select the field unit assigned to you.
          </p>

          {technicians.map((crew) => (
            <button
              key={crew.id}
              className="crew-login-card"
              onClick={() => onSelect(crew)}
            >
              <div className="avatar">
                {crew.name.charAt(5)}
              </div>

              <div>
                <strong>{crew.name}</strong>

                <span>{crew.lead}</span>

                <small>
                  {crew.id} · {crew.role}
                </small>
              </div>

              <b>→</b>
            </button>
          ))}
        </div>

        <div className="login-footer">
          Secure field session · Offline capable
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   LEADER LOGIN
========================================================= */

function LeaderLogin({ onSelect, onBack }) {
  const leaders = CREWS.filter(
    (crew) => crew.role === "Crew Lead"
  );

  return (
    <div className="app-shell">
      <div className="login-screen">
        <button className="back-button" onClick={onBack}>
          ← Back
        </button>

        <div className="brand">
          <div className="brand-icon">⚡</div>

          <div>
            <h1>
              OMS <span>Leader</span>
            </h1>

            <p>Crew Leader Login</p>
          </div>
        </div>

        <div className="login-card">
          <h2>Select leader account</h2>

          <p className="muted">
            Access the field operations dashboard.
          </p>

          {leaders.map((crew) => (
            <button
              key={crew.id}
              className="crew-login-card"
              onClick={() => onSelect(crew)}
            >
              <div className="avatar leader-avatar">
                {crew.name.charAt(5)}
              </div>

              <div>
                <strong>{crew.name}</strong>

                <span>{crew.lead}</span>

                <small>
                  {crew.id} · Crew Leader
                </small>
              </div>

              <b>→</b>
            </button>
          ))}
        </div>

        <div className="login-footer">
          Operations Control · UPCL Ganga Corridor
        </div>
      </div>
    </div>
  );
}

/* =========================================================
   CREW LAYOUT
========================================================= */

function CrewLayout({ crew, jobs, onUpdateJob, omsSource, onLogout }) {
  const [tab, setTab] = useState("jobs");

  return (
    <div className="phone-app">
      <Header
        crew={crew}
        title="Field Crew"
        onLogout={onLogout}
      />

      <main className="app-content">
        {tab === "jobs" && (
          <CrewJobs
            jobs={jobs}
            crew={crew}
            onUpdate={onUpdateJob}
            omsSource={omsSource}
          />
        )}

        {tab === "map" && <MapView jobs={jobs} />}

        {tab === "me" && (
          <Profile
            crew={crew}
            onLogout={onLogout}
          />
        )}
      </main>

      <BottomNavigation
        tab={tab}
        setTab={setTab}
        items={[
          ["jobs", "Jobs", "📋"],
          ["map", "Map", "🗺️"],
          ["me", "Me", "👤"],
        ]}
      />
    </div>
  );
}

/* =========================================================
   CREW JOBS
========================================================= */

function CrewJobs({ jobs, crew, onUpdate, omsSource }) {
  const visibleJobs = jobs.filter(
    (job) => !job.assignedCrewId || job.assignedCrewId === crew.id
  );
  const pendingJobs = visibleJobs.filter(
    (job) => job.status === "Pending Acceptance"
  );

  return (
    <>
      <PageHeader
        title="My Jobs"
        subtitle={`${visibleJobs.length} assigned outages · ${omsSource === "oms" ? "Live OMS feed" : "Demo OMS feed"}`}
      />

      <div className="summary-row">
        <SummaryCard
          label="Assigned"
          value={visibleJobs.length}
        />

        <SummaryCard
          label="Urgent"
          value={
            visibleJobs.filter(
              (job) => job.priority === "Urgent"
            ).length
          }
        />

        <SummaryCard
          label="Active"
          value={
            visibleJobs.filter(
              (job) =>
                job.status !== "Work Complete"
            ).length
          }
        />
      </div>

      {pendingJobs.length > 0 && (
        <>
          <div className="section-title pending-title">Pending acceptance</div>
          <div className="pending-task-note">
            OMS assigned this task to you as the nearest ready crew.
          </div>
        </>
      )}

      <div className="section-title">
        Assigned outages
      </div>

      <div className="job-list">
        {visibleJobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </>
  );
}

/* =========================================================
   JOB CARD
========================================================= */

function JobCard({ job, onUpdate }) {
  const [expanded, setExpanded] = useState(false);

  const nextStatus = {
    "Pending Acceptance": "Acknowledged",
    Acknowledged: "En Route",
    "En Route": "On Site",
    "On Site": "Work Started",
    "Work Started": "Work Complete",
  };

  return (
    <div className={`job-card ${job.status === "Pending Acceptance" ? "is-pending" : ""}`}>
      <div className="job-top">
        <div>
          <span
            className={`severity ${severityClass(job.severity)}`}
          >
            {job.severity}
          </span>

          {job.priority === "Urgent" && (
            <span className="urgent-badge">
              URGENT
            </span>
          )}
        </div>

        <span className={`job-id incident-token ${severityClass(job.severity)}`}>
          {job.id}
        </span>
      </div>

      <h3>{job.title}</h3>

      <p className="job-address">
        📍 {job.address}
      </p>

      <div className="job-info">
        <span>⚡ {job.feeder}</span>
        <span>📏 {job.distance}</span>
        <span>👥 {job.customers}</span>
      </div>

      <div className="job-status-row">
        <span>Status</span>

        <strong>
          {job.status === "Pending Acceptance" ? "Awaiting your acceptance" : job.status}
        </strong>
      </div>

      {job.status === "Pending Acceptance" && (
        <div className="pending-assignee">
          Nearest ready crew · {job.assignedDistance}
        </div>
      )}

      {expanded && (
        <div className="job-details">
          <div>
            <span>Estimated arrival</span>
            <strong>{job.eta}</strong>
          </div>

          <div>
            <span>Customers affected</span>
            <strong>{job.customers}</strong>
          </div>

          <div>
            <span>Feeder</span>
            <strong>{job.feeder}</strong>
          </div>
        </div>
      )}

      <div className="job-actions">
        <button
          className="secondary-btn"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide details" : "View details"}
        </button>

        {nextStatus[job.status] && (
          <button
            className="primary-btn"
            onClick={() =>
                onUpdate(job.id, {
                  status: nextStatus[job.status],
                  acceptance: job.status === "Pending Acceptance" ? "Accepted" : job.acceptance,
                })
            }
          >
              {job.status === "Pending Acceptance" ? "Accept task" : `${nextStatus[job.status]} →`}
          </button>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   LEADER LAYOUT
========================================================= */

function LeaderLayout({ crew, jobs, omsSource, onLogout }) {
  const [tab, setTab] = useState("dashboard");
  const [selectedJobId, setSelectedJobId] = useState(null);
  const selectedJob = jobs.find((job) => job.id === selectedJobId);

  return (
    <div className="leader-app">
      <LeaderHeader
        crew={crew}
        onLogout={onLogout}
      />

      <main className="leader-content">
        {tab === "dashboard" && (
          <LeaderDashboard jobs={jobs} omsSource={omsSource} />
        )}

        {tab === "jobs" && (
          selectedJob ? (
            <LeaderJobDetail
              job={selectedJob}
              onBack={() => setSelectedJobId(null)}
            />
          ) : (
            <LeaderJobs
              jobs={jobs}
              omsSource={omsSource}
              onSelectJob={setSelectedJobId}
            />
          )
        )}

        {tab === "team" && (
          <TeamOverview jobs={jobs} />
        )}

        {tab === "map" && (
          <MapView jobs={jobs} />
        )}

        {tab === "me" && (
          <Profile
            crew={crew}
            onLogout={onLogout}
          />
        )}
      </main>

      <BottomNavigation
        tab={tab}
        setTab={setTab}
        items={[
          ["dashboard", "Dashboard", "📊"],
          ["jobs", "Jobs", "📋"],
          ["team", "Team", "👥"],
          ["map", "Map", "🗺️"],
          ["me", "Me", "👤"],
        ]}
      />
    </div>
  );
}

/* =========================================================
   LEADER DASHBOARD
========================================================= */

function LeaderDashboard({ jobs, omsSource }) {
  const critical = jobs.filter(
    (j) => j.severity === "Critical"
  ).length;

  const urgent = jobs.filter(
    (j) => j.priority === "Urgent"
  ).length;

  const active = jobs.filter(
    (j) => j.status !== "Work Complete"
  ).length;

  const pending = jobs.filter(
    (j) => j.status === "Pending Acceptance"
  ).length;

  return (
    <>
      <PageHeader
        title="Operations Dashboard"
        subtitle={`Ganga Corridor · ${omsSource === "oms" ? "Live OMS priority jobs" : "Demo OMS priority jobs"}`}
      />

      <div className="dashboard-grid">
        <DashboardCard
          title="Active Outages"
          value={active}
          icon="⚡"
        />

        <DashboardCard
          title="Critical"
          value={critical}
          icon="🚨"
        />

        <DashboardCard
          title="Urgent Jobs"
          value={urgent}
          icon="🔥"
        />

        <DashboardCard
          title="Crews Online"
          value="4/5"
          icon="👷"
        />

        <DashboardCard
          title="Pending Acceptance"
          value={pending}
          icon="⏳"
        />
      </div>

      {pending > 0 && (
        <>
          <div className="section-title">Pending tasks</div>
          {jobs.filter((job) => job.status === "Pending Acceptance").map((job) => (
            <div className="pending-leader-card" key={job.id}>
              <div>
                <strong>{job.title}</strong>
                <span>{job.id} · {job.address}</span>
              </div>
              <small>Nearest ready crew<br />{job.assignedDistance}</small>
            </div>
          ))}
        </>
      )}

      <div className="section-title">
        Network status
      </div>

      <div className="network-card">
        <div className="network-header">
          <div>
            <span className="online-dot" />
            System Operational
          </div>

          <strong>98.4%</strong>
        </div>

        <div className="network-bar">
          <div />
        </div>

        <div className="network-footer">
          <span>Voltage stable</span>
          <span>SCADA connected</span>
          <span>Database synced</span>
        </div>
      </div>

      <div className="section-title">
        Critical incidents
      </div>

      {jobs.filter(
        (job) => job.severity === "Critical"
      ).map((job) => (
        <div className="incident-alert" key={job.id}>
          <div className="alert-icon">!</div>

          <div>
            <strong>{job.title}</strong>

            <span>{job.address}</span>

            <small>
              {job.customers} customers affected
            </small>
          </div>

          <span className="alert-status">
            {job.status}
          </span>
        </div>
      ))}
    </>
  );
}

/* =========================================================
   LEADER JOBS
========================================================= */

function LeaderJobs({ jobs, omsSource, onSelectJob }) {
  const [filter, setFilter] = useState("All");
  const pendingJobs = jobs.filter(
    (job) => job.status === "Pending Acceptance"
  );
  const filteredJobs = jobs.filter((job) => {
    if (filter === "Pending") return job.status === "Pending Acceptance";
    if (filter === "Urgent") return job.priority === "Urgent";
    if (filter === "Active") return job.status !== "Work Complete";
    if (filter === "Completed") return job.status === "Work Complete";
    return true;
  });

  return (
    <>
      <PageHeader
        title="All Jobs"
        subtitle={`${pendingJobs.length} pending acceptance · ${omsSource === "oms" ? "Live OMS assignment feed" : "Demo OMS assignment feed"}`}
      />

      <div className="leader-filter-row">
        {["All", "Pending", "Urgent", "Active", "Completed"].map((option) => (
          <button
            key={option}
            className={filter === option ? "filter-active" : ""}
            onClick={() => setFilter(option)}
          >
            {option}
          </button>
        ))}
      </div>

      <div className="job-list">
        {filteredJobs.map((job) => (
          <div
            className="leader-job-card"
            key={job.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectJob(job.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectJob(job.id);
              }
            }}
          >
            <div>
              <span
                className={`severity ${severityClass(job.severity)}`}
              >
                {job.severity}
              </span>

              <h3>{job.title}</h3>

              <p>{job.address}</p>
            </div>

            <div className="leader-job-right">
              <strong className={job.status === "Pending Acceptance" ? "pending-status" : ""}>
                {job.status === "Pending Acceptance" ? "Pending acceptance" : job.status}
              </strong>

              <small>
                {job.id}
              </small>
            </div>

            {job.status === "Pending Acceptance" && (
              <div className="leader-pending-meta">
                OMS assigned nearest ready crew · {job.assignedDistance}
              </div>
            )}

          </div>
        ))}
      </div>

      {filteredJobs.length === 0 && (
        <div className="none">
          <div className="none-ico">✓</div>
          No {filter.toLowerCase()} jobs found
        </div>
      )}
    </>
  );
}

function LeaderJobDetail({ job, onBack }) {
  const isPending = job.status === "Pending Acceptance";

  return (
    <div className="leader-job-detail">
      <button className="detail-back-button" onClick={onBack}>
        <span>←</span> Back to all jobs
      </button>

      <div className="detail-heading">
        <div>
          <span className={`severity ${severityClass(job.severity)}`}>
            {job.severity}
          </span>
          {job.priority === "Urgent" && (
            <span className="urgent-badge">URGENT</span>
          )}
          <h1>{job.title}</h1>
          <p>{job.id} · {job.address}</p>
        </div>
        <strong className={isPending ? "pending-status" : "detail-status"}>
          {isPending ? "Awaiting acceptance" : job.status}
        </strong>
      </div>

      <div className="detail-meta-grid">
        <div><small>Feeder</small><strong>{job.feeder}</strong></div>
        <div><small>Customers affected</small><strong>{job.customers}</strong></div>
        <div><small>Distance</small><strong>{job.distance}</strong></div>
        <div><small>Estimated arrival</small><strong>{job.eta}</strong></div>
      </div>

      <div className="detail-section">
        <h2>OMS assignment</h2>
        <p>
          {job.assignedCrewId
            ? `Assigned crew: ${job.assignedCrewId}`
            : "Waiting for OMS crew assignment"}
        </p>
        {isPending && (
          <div className="detail-pending-note">
            Nearest ready crew selected by OMS · {job.assignedDistance}
          </div>
        )}
      </div>

      <div className="detail-section">
        <h2>Incident location</h2>
        <p>{job.address}</p>
        <div className="detail-map-placeholder">📍 OMS location preview</div>
      </div>
    </div>
  );
}

/* =========================================================
   TEAM OVERVIEW
========================================================= */

function TeamOverview({ jobs }) {

  return (
    <>
      <PageHeader
        title="Team Overview"
        subtitle="Live status of field crews"
      />

      <div className="team-summary">
        <div>
          <strong>{CREWS.filter((item) => CREW_STATUSES[item.name] !== "Offline").length}</strong>
          <span>Online</span>
        </div>

        <div>
          <strong>{CREWS.filter((item) => CREW_STATUSES[item.name] === "On Site").length}</strong>
          <span>On Site</span>
        </div>

        <div>
          <strong>{CREWS.filter((item) => CREW_STATUSES[item.name] === "En Route").length}</strong>
          <span>En Route</span>
        </div>
      </div>

      <div className="section-title">
        Field units
      </div>

      <div className="team-list">
        {CREWS.map((crew) => (
          <div className="team-card" key={crew.id}>
            <div className="avatar">
              {crew.name.charAt(5)}
            </div>

            <div className="team-info">
              <strong>{crew.name}</strong>

              <span>
                {crew.lead}
              </span>

              <small>
                {crew.skills.join(" · ")}
              </small>
              {jobs.filter((job) => job.assignedCrewId === crew.id).map((job) => (
                <em className="team-assignment" key={job.id}>{job.id} · {job.title}</em>
              ))}
            </div>

            <div
              className={`team-status ${
                jobs.some((job) => job.assignedCrewId === crew.id)
                  ? "busy"
                  : CREW_STATUSES[crew.name] === "Offline"
                  ? "offline"
                  : CREW_STATUSES[crew.name] ===
                    "Available"
                  ? "available"
                  : "busy"
              }`}
            >
              <span />
              {jobs.some((job) => job.assignedCrewId === crew.id)
                ? "Assigned"
                : CREW_STATUSES[crew.name]}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* =========================================================
   MAP
========================================================= */

function MapView({ jobs }) {
  return (
    <>
      <PageHeader
        title="Outage Map"
        subtitle="Assigned incidents across the corridor"
      />

      <div className="map-container">
        <div className="map-grid">
          <div className="map-road road-1" />
          <div className="map-road road-2" />
          <div className="map-road road-3" />

          <div className="map-river" />

          {jobs.map((job, index) => (
            <div
              key={job.id}
              className={`map-marker marker-${index} marker-${severityClass(job.severity)}`}
              title={job.title}
            >
              ⚡
            </div>
          ))}

          <div className="crew-marker">
            👷
          </div>
        </div>

        <div className="map-legend">
          <span>
            <i className="legend-dot crew" />
            Crew
          </span>

          <span>
            <i className="legend-dot critical" />
            Critical
          </span>

          <span>
            <i className="legend-dot normal" />
            Incident
          </span>
        </div>
      </div>

      <div className="map-note">
        Tap an incident marker to view the outage
        location and assigned crew.
      </div>
    </>
  );
}

/* =========================================================
   PROFILE
========================================================= */

function Profile({ crew, onLogout }) {
  const [showSignOut, setShowSignOut] = useState(false);
  const [settings, setSettings] = useState({
    notifications: true,
    biometric: true,
    offline: true,
  });

  const toggleSetting = (setting) => {
    setSettings((current) => ({
      ...current,
      [setting]: !current[setting],
    }));
  };

  if (showSignOut) {
    return (
      <div className="signout-page">
        <div className="signout-icon">↗</div>
        <PageHeader
          title="Sign out"
          subtitle="End your current OMS field session"
        />

        <div className="signout-panel">
          <h2>Ready to sign out?</h2>
          <p>
            Your local session will close. You can sign in again with your OMS
            email and password.
          </p>
          <div className="signout-actions">
            <button
              className="signout-cancel"
              onClick={() => setShowSignOut(false)}
            >
              Cancel
            </button>
            <button className="signout-confirm" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="My Profile"
        subtitle="Account and session information"
      />

      <div className="profile-card">
        <div className="profile-avatar">
          {crew.name.charAt(5)}
        </div>

        <div>
          <h2>{crew.name}</h2>

          <p>{crew.lead}</p>

          <span>{crew.id}</span>
        </div>
      </div>

      <div className="profile-grid">
        <div>
          <small>Role</small>
          <strong>{crew.role}</strong>
        </div>

        <div>
          <small>Shift</small>
          <strong>{crew.shift}</strong>
        </div>

        <div>
          <small>Skills</small>
          <strong>
            {crew.skills.join(", ")}
          </strong>
        </div>

        <div>
          <small>Network</small>
          <strong className="green-text">
            Online
          </strong>
        </div>
      </div>

      <div className="settings-card">
        <h3>Settings</h3>

        <div className="setting-row">
          <span>Push notifications</span>
          <button
            className={`toggle ${settings.notifications ? "active" : ""}`}
            aria-label="Toggle push notifications"
            aria-pressed={settings.notifications}
            onClick={() => toggleSetting("notifications")}
          >
            <span />
          </button>
        </div>

        <div className="setting-row">
          <span>Biometric unlock</span>
          <button
            className={`toggle ${settings.biometric ? "active" : ""}`}
            aria-label="Toggle biometric unlock"
            aria-pressed={settings.biometric}
            onClick={() => toggleSetting("biometric")}
          >
            <span />
          </button>
        </div>

        <div className="setting-row">
          <span>Offline mode</span>
          <button
            className={`toggle ${settings.offline ? "active" : ""}`}
            aria-label="Toggle offline mode"
            aria-pressed={settings.offline}
            onClick={() => toggleSetting("offline")}
          >
            <span />
          </button>
        </div>
      </div>

      <button
        className="logout-button"
        onClick={() => setShowSignOut(true)}
      >
        Sign out
      </button>
    </>
  );
}

/* =========================================================
   HEADER
========================================================= */

function Header({ crew, title, onLogout }) {
  return (
    <header className="mobile-header">
      <div>
        <div className="header-brand">
          ⚡ OMS Crew
        </div>

        <small>
          {title}
        </small>
      </div>

      <button
        className="header-avatar"
        onClick={onLogout}
        title="Sign out"
      >
        {crew.name.charAt(5)}
      </button>
    </header>
  );
}

/* =========================================================
   LEADER HEADER
========================================================= */

function LeaderHeader({ crew, onLogout }) {
  return (
    <header className="leader-header">
      <div>
        <div className="header-brand">
          ⚡ OMS Leader
        </div>

        <small>
          Ganga Corridor Operations
        </small>
      </div>

      <div className="leader-header-right">
        <div className="system-online">
          <span />
          System Online
        </div>

        <button
          className="header-avatar"
          onClick={onLogout}
        >
          {crew.name.charAt(5)}
        </button>
      </div>
    </header>
  );
}

/* =========================================================
   BOTTOM NAVIGATION
========================================================= */

function BottomNavigation({
  tab,
  setTab,
  items,
}) {
  return (
    <nav className="bottom-navigation">
      {items.map(([id, label, icon]) => (
        <button
          key={id}
          className={
            tab === id ? "nav-active" : ""
          }
          onClick={() => setTab(id)}
        >
          <span>{icon}</span>
          <small>{label}</small>
        </button>
      ))}
    </nav>
  );
}

/* =========================================================
   PAGE HEADER
========================================================= */

function PageHeader({ title, subtitle }) {
  return (
    <div className="page-header">
      <h1>{title}</h1>

      <p>{subtitle}</p>
    </div>
  );
}

/* =========================================================
   SUMMARY CARD
========================================================= */

function SummaryCard({ label, value }) {
  return (
    <div className="summary-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/* =========================================================
   DASHBOARD CARD
========================================================= */

function DashboardCard({
  title,
  value,
  icon,
}) {
  return (
    <div className="dashboard-card">
      <div className="dashboard-icon">
        {icon}
      </div>

      <div>
        <span>{title}</span>
        <strong>{value}</strong>
      </div>
    </div>
  );
}