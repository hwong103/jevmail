import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, SVGProps } from "react";
import type { AnswerDto, MessageBody, MessageListItem, MessagePage } from "../contracts/dto";
import { QUESTION_LABELS, TRAY_LABELS, type Question, type Tray } from "../contracts/ui-types";
import { fetchBody, fetchSyncStatus, listMessages, submitCorrection } from "./api";

const TRAY_ORDER: Tray[] = [
  "needs_reply",
  "action",
  "review",
  "updates",
  "low_priority",
];

// Valid correction targets per question. A correction must always carry a
// value the schema accepts, so the editor cannot produce an invalid answer.
const OPTIONS: Record<Question, readonly AnswerDto["value"][]> = {
  category: [
    "personal",
    "work",
    "transactional",
    "newsletter",
    "marketing",
    "cold_outreach",
    "notification",
    "other",
  ],
  needsReply: [true, false],
  needsAction: [true, false],
  urgency: [1, 2, 3, 4, 5],
  importance: [1, 2, 3, 4, 5],
  senderType: ["person", "organization", "automated", "unknown"],
};

function display(option: AnswerDto["value"]): string {
  if (typeof option === "boolean") return option ? "yes" : "no";
  return String(option);
}

function isSelected(answer: AnswerDto, option: AnswerDto["value"]): boolean {
  return answer.state === "value" && answer.value === option;
}

function formatValue(answer: AnswerDto): string {
  if (answer.state !== "value" || answer.value === undefined) return "not answered";
  const value = answer.value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// Gmail date rule: time when it arrived today, day + month within the year,
// and a short numeric date for anything older.
function formatListDate(timestamp: number): string {
  const then = new Date(timestamp);
  const now = new Date();
  if (then.toDateString() === now.toDateString()) {
    return then.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const day = then.getDate();
  if (then.getFullYear() === now.getFullYear()) {
    return `${day} ${then.toLocaleString([], { month: "short" })}`;
  }
  const dd = String(day).padStart(2, "0");
  const mm = String(then.getMonth() + 1).padStart(2, "0");
  const yy = String(then.getFullYear()).slice(2);
  return `${dd}/${mm}/${yy}`;
}

// Saturated, white-text-safe avatar colours (all >= 4.5:1 against #fff).
const AVATAR_COLORS = [
  "#c5221f",
  "#188038",
  "#1967d2",
  "#b06000",
  "#8430ce",
  "#00695c",
  "#5f6368",
  "#d81b60",
];

function avatarColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#5f6368";
}

function initialOf(sender: string): string {
  const match = sender.trim().match(/[a-z0-9]/i);
  return (match ? match[0] : "?").toUpperCase();
}

function Icon({ children, ...rest }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

function LogoMark() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5" width="19" height="14" rx="3" fill="currentColor" />
      <path
        d="m4.5 8 7.5 5.2L19.5 8"
        fill="none"
        stroke="var(--surface)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <Icon>
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </Icon>
  );
}

function CloseIcon() {
  return (
    <Icon>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </Icon>
  );
}

function MenuIcon() {
  return (
    <Icon>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </Icon>
  );
}

function BackIcon() {
  return (
    <Icon>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </Icon>
  );
}

function ChevronIcon() {
  return (
    <Icon className="chevron">
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

function EditIcon() {
  return (
    <Icon>
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z" />
      <path d="m14.5 6.5 3 3" />
    </Icon>
  );
}

function ExternalIcon() {
  return (
    <Icon>
      <path d="M14 4h6v6" />
      <path d="M20 4 10.5 13.5" />
      <path d="M19 14.5V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4.5" />
    </Icon>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <Icon className={`star${filled ? " star--on" : ""}`} fill={filled ? "currentColor" : "none"}>
      <path d="M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 17l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z" />
    </Icon>
  );
}

const TRAY_ICONS: Record<Tray, ReactNode> = {
  needs_reply: (
    <>
      <path d="M8 7 3 12l5 5" />
      <path d="M3 12h9a6 6 0 0 1 6 6v1" />
    </>
  ),
  action: (
    <>
      <path d="m3 7 1.6 1.6L7.4 5.8" />
      <path d="M11 7.5h10" />
      <path d="m3 16 1.6 1.6 2.8-2.8" />
      <path d="M11 16.5h10" />
    </>
  ),
  review: (
    <>
      <path d="M6 21V4" />
      <path d="M6 4.5h11l-2.2 4 2.2 4H6" />
    </>
  ),
  updates: (
    <>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M10.5 20.5a2 2 0 0 0 3 0" />
    </>
  ),
  low_priority: (
    <>
      <rect x="3" y="4" width="18" height="4.5" rx="1.2" />
      <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" />
      <path d="M10 12.5h4" />
    </>
  ),
};

function Avatar({ sender, large }: { sender: string; large?: boolean }) {
  return (
    <span
      className={`avatar${large ? " avatar--lg" : ""}`}
      style={{ backgroundColor: avatarColor(sender) }}
      aria-hidden="true"
    >
      {initialOf(sender)}
    </span>
  );
}

function AnswerRow({ answer }: { answer: AnswerDto }) {
  const unknown = answer.state !== "value";
  return (
    <div className={`answer${unknown ? " unknown" : ""}${answer.corrected ? " corrected" : ""}`}>
      <span className="label">{QUESTION_LABELS[answer.question as Question]}</span>
      <span className="value">{formatValue(answer)}</span>
      {!unknown && answer.confidence !== null && (
        <span className="confidence">{(answer.confidence * 100).toFixed(0)}%</span>
      )}
      {!unknown && answer.confidence === null && answer.corrected && (
        <span className="confidence">your call</span>
      )}
    </div>
  );
}

function MessageRow({
  item,
  selected,
  onSelect,
}: {
  item: MessageListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      className={`row${item.isUnread ? " row--unread" : ""}`}
      aria-current={selected}
      onClick={onSelect}
    >
      <Avatar sender={item.sender} />
      <span className="row-sender" title={item.sender}>
        {item.sender}
      </span>
      <span className="row-subject" title={item.subject}>
        {item.subject}
      </span>
      <span className="row-meta">
        {item.isStarred && <StarIcon filled />}
        <span className="date">{formatListDate(item.receivedAt)}</span>
      </span>
    </button>
  );
}

function Reader({
  item,
  onCorrect,
  correcting,
  onToggleCorrect,
  onBack,
}: {
  item: MessageListItem;
  onCorrect: (question: Question, value: AnswerDto["value"]) => void;
  correcting: boolean;
  onToggleCorrect: () => void;
  onBack: () => void;
}) {
  const [body, setBody] = useState<MessageBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const disclosure = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBody(null);
    setError(null);
    fetchBody(item.gmailMessageId, controller.signal)
      .then(setBody)
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load this message");
      });
    // The body is dropped on every navigation, so it never accumulates.
    return () => controller.abort();
  }, [item.gmailMessageId]);

  // The correction editor lives inside the disclosure. If correcting is
  // triggered without the user opening it (e.g. programmatically), open it so
  // the editor is never stranded out of view.
  useEffect(() => {
    if (correcting && disclosure.current) disclosure.current.open = true;
  }, [correcting]);

  const gmailUrl = `https://mail.google.com/mail/u/0/#all/${item.gmailMessageId}`;

  return (
    <div className="reader-inner" key={item.gmailMessageId}>
      <div className="reader-toolbar">
        <button className="icon-btn" aria-label="Back to list" onClick={onBack}>
          <BackIcon />
        </button>
        <span className="tray-chip">
          <Icon width={16} height={16}>
            {TRAY_ICONS[item.tray]}
          </Icon>
          {TRAY_LABELS[item.tray]}
        </span>
        <span className="toolbar-spacer" />
        <a className="pill" href={gmailUrl} target="_blank" rel="noreferrer noopener">
          <ExternalIcon />
          Open in Gmail
        </a>
      </div>

      <h2 className="reader-subject">{item.subject}</h2>

      <div className="reader-sender">
        <Avatar sender={item.sender} large />
        <div className="reader-sender-text">
          <span className="reader-sender-name">{item.sender}</span>
          <span className="reader-sender-date">{new Date(item.receivedAt).toLocaleString()}</span>
        </div>
      </div>

      {item.pendingInThread > 0 && (
        <div className="banner">
          {item.pendingInThread} newer message{item.pendingInThread === 1 ? "" : "s"} in this
          thread {item.pendingInThread === 1 ? "has" : "have"} not been classified yet.
        </div>
      )}

      {item.quality === "missing_body" && (
        <div className="banner">
          This message has no readable body, so it was not classified. Open it in Gmail.
        </div>
      )}

      {body?.text ? (
        <div className="body-text">{body.text}</div>
      ) : (
        // When the body is missing, the classification banner above already says
        // so. Repeating it here read as a duplicate warning.
        body?.unavailableReason &&
        item.quality !== "missing_body" && <div className="banner">{body.unavailableReason}</div>
      )}

      {error && <div className="banner">{error}</div>}

      <details className="reader-secondary" ref={disclosure}>
        <summary className="reader-secondary-summary">
          <ChevronIcon />
          <span className="reader-secondary-label">Why this landed here</span>
          {item.trayReasons[0] && (
            <span className="reader-secondary-hint">{item.trayReasons[0]}</span>
          )}
        </summary>

        <div className="reader-secondary-body">
          <ul className="why">
            {item.trayReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>

          <div className="answers">
            {item.answers.map((answer) => (
              <AnswerRow key={answer.question} answer={answer} />
            ))}
          </div>

          <button
            className="quiet-btn quiet-btn--inline"
            aria-pressed={correcting}
            onClick={onToggleCorrect}
          >
            <EditIcon />
            Correct a field
          </button>

          {correcting && (
            <div className="corrections">
              <div className="corrections-head">
                <span>Correct a field</span>
                <button className="quiet-btn" onClick={onToggleCorrect}>
                  Cancel
                </button>
              </div>
              {item.answers.map((answer) => (
                <fieldset key={answer.question}>
                  <legend>{QUESTION_LABELS[answer.question]}</legend>
                  <div className="options">
                    {OPTIONS[answer.question].map((option) => (
                      <button
                        key={display(option)}
                        aria-pressed={isSelected(answer, option)}
                        onClick={() => onCorrect(answer.question, option)}
                      >
                        {display(option)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

export function App() {
  const [tray, setTray] = useState<Tray>("needs_reply");
  const [page, setPage] = useState<MessagePage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [syncLabel, setSyncLabel] = useState<string>("idle");
  const [query, setQuery] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const reloadTimer = useRef<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listMessages(tray, null, controller.signal)
      .then(setPage)
      .catch(() => setPage(null))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [tray]);

  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      fetchSyncStatus(controller.signal)
        .then((status) => setSyncLabel(status.state === "idle" ? "synced" : status.state))
        .catch(() => setSyncLabel("offline"));
    };
    poll();
    // Polling backs off and stops entirely when the tab is hidden, so a
    // backgrounded app cannot quietly burn quota.
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") poll();
    }, 30_000);
    reloadTimer.current = timer as unknown as number;
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const selected = page?.messages.find((item) => item.gmailMessageId === selectedId) ?? null;
  // Set by the OAuth callback redirect. Present only for the redirect it follows.
  const connected = typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("connected");

  const messages = useMemo(() => {
    const all = page?.messages ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (item) =>
        item.sender.toLowerCase().includes(needle) ||
        item.subject.toLowerCase().includes(needle),
    );
  }, [page, query]);

  const onCorrect = useCallback(
    async (question: Question, value: AnswerDto["value"]) => {
      if (!selected) return;
      if (!selected.answers.some((answer) => answer.question === question)) return;
      await submitCorrection(selected.gmailMessageId, {
        gmailMessageId: selected.gmailMessageId,
        changes: [{ question, operation: "set", value }],
      });
      setCorrecting(false);
      const refreshed = await listMessages(tray, null);
      setPage(refreshed);
    },
    [selected, tray],
  );

  return (
    <div className="shell" data-view={selected ? "reader" : "list"}>
      <header className="topbar">
        <button
          className="icon-btn nav-toggle"
          aria-label="Toggle navigation"
          aria-expanded={navOpen}
          aria-controls="trays"
          onClick={() => setNavOpen((open) => !open)}
        >
          <MenuIcon />
        </button>
        <span className="brand">
          <span className="brand-mark">
            <LogoMark />
          </span>
          <span className="brand-name">Jevmail</span>
        </span>

        <form className="search" role="search" onSubmit={(event) => event.preventDefault()}>
          <span className="search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            type="text"
            className="search-input"
            placeholder="Search mail"
            aria-label="Search mail"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              className="search-clear"
              aria-label="Clear search"
              onClick={() => setQuery("")}
            >
              <CloseIcon />
            </button>
          )}
        </form>

        <div className="status-chips">
          <span className="status-chip">read-only</span>
          <span className="status-chip">automation off</span>
          <span className="status-chip">{syncLabel}</span>
        </div>
        <a className="pill" href="/auth/google">
          {connected ? "Reconnect Gmail" : "Connect Gmail"}
        </a>
      </header>

      <div className="frame">
        <div
          className={`nav-backdrop${navOpen ? " nav-backdrop--show" : ""}`}
          onClick={() => setNavOpen(false)}
          aria-hidden="true"
        />
        <nav id="trays" className={`rail${navOpen ? " rail--open" : ""}`} aria-label="Trays">
          {TRAY_ORDER.map((key) => (
            <button
              key={key}
              className="nav-item"
              aria-current={tray === key ? "page" : undefined}
              onClick={() => {
                setTray(key);
                setSelectedId(null);
                setNavOpen(false);
              }}
            >
              <span className="nav-icon">
                <Icon>{TRAY_ICONS[key]}</Icon>
              </span>
              {TRAY_LABELS[key]}
            </button>
          ))}
          <div className="rail-foot">
            <span className="rail-status">
              <span className="dot" aria-hidden="true" />
              Automation off
            </span>
            <span className="rail-status rail-status--muted">Sync: {syncLabel}</span>
          </div>
        </nav>

        <div className="content">
          <div className="panes">
            <div className="list" aria-label="Messages">
              {loading && <div className="empty">Loading…</div>}
              {!loading && (page?.messages.length ?? 0) === 0 && (
                <div className="empty">Nothing here.</div>
              )}
              {!loading && (page?.messages.length ?? 0) > 0 && messages.length === 0 && (
                <div className="empty">No messages match “{query.trim()}”.</div>
              )}
              {messages.map((item) => (
                <MessageRow
                  key={item.gmailMessageId}
                  item={item}
                  selected={item.gmailMessageId === selectedId}
                  onSelect={() => {
                    setSelectedId(item.gmailMessageId);
                    setCorrecting(false);
                  }}
                />
              ))}
            </div>

            <div className="reader" hidden={selected === null}>
              {selected !== null && (
                <Reader
                  item={selected}
                  onCorrect={onCorrect}
                  correcting={correcting}
                  onToggleCorrect={() => setCorrecting((value) => !value)}
                  onBack={() => setSelectedId(null)}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
