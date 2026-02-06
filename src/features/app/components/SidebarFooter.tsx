type SidebarFooterProps = {
  sessionPercent: number | null;
  sessionResetLabel: string | null;
  creditsLabel: string | null;
};

export function SidebarFooter({
  sessionPercent,
  sessionResetLabel,
  creditsLabel,
}: SidebarFooterProps) {
  return (
    <div className="sidebar-footer">
      <div className="usage-bars">
        <div className="usage-block">
          <div className="usage-label">
            <span className="usage-title">
              <span>Copilot</span>
              {sessionResetLabel && (
                <span className="usage-reset">· {sessionResetLabel}</span>
              )}
            </span>
            <span className="usage-value">
              {sessionPercent === null ? "--" : `${sessionPercent}%`}
            </span>
          </div>
          <div className="usage-bar">
            <span
              className="usage-bar-fill"
              style={{ width: `${sessionPercent ?? 0}%` }}
            />
          </div>
        </div>
      </div>
      {creditsLabel && <div className="usage-meta">{creditsLabel}</div>}
    </div>
  );
}
