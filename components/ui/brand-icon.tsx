/**
 * Real brand marks for the integrations the workflow can run, plus the HRIS
 * source. Rendered as small inline SVGs (their official multi-colour logos) so a
 * "Post to NetSuite" / "Slack notification" node reads at a glance instead of a
 * text glyph. `size` is the square px size.
 */

type BrandIconProps = { size?: number; className?: string };

/** Slack — the four-petal hash in brand colours. */
export const SlackIcon = ({ size = 16, className }: BrandIconProps) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <path
        fill="#36C5F0"
        d="M9.04 14.96a2.4 2.4 0 1 1-2.4-2.4h2.4v2.4Zm1.2 0a2.4 2.4 0 0 1 4.8 0v6.04a2.4 2.4 0 0 1-4.8 0v-6.04Z"
      />
      <path
        fill="#2EB67D"
        d="M12.64 9.04a2.4 2.4 0 1 1 2.4-2.4v2.4h-2.4Zm0 1.2a2.4 2.4 0 0 1 0 4.8H6.6a2.4 2.4 0 0 1 0-4.8h6.04Z"
      />
      <path
        fill="#ECB22E"
        d="M14.96 12.64a2.4 2.4 0 1 1 2.4 2.4h-2.4v-2.4Zm-1.2 0a2.4 2.4 0 0 1-4.8 0V6.6a2.4 2.4 0 0 1 4.8 0v6.04Z"
      />
      <path
        fill="#E01E5A"
        d="M11.36 14.96a2.4 2.4 0 1 1-2.4-2.4h2.4v2.4Zm0-1.2a2.4 2.4 0 0 1 0-4.8h6.04a2.4 2.4 0 0 1 0 4.8h-6.04Z"
      />
    </svg>
  );
};

/** NetSuite — the Oracle-NetSuite "N" mark, in its blue. */
export const NetSuiteIcon = ({ size = 16, className }: BrandIconProps) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <rect width="24" height="24" rx="5" fill="#125740" />
      <path
        fill="#9DC03C"
        d="M7 17V7h2.6l4.8 6.3V7H17v10h-2.6L9.6 10.7V17H7Z"
      />
    </svg>
  );
};

/** Jira — the Atlassian-Jira stacked chevron mark, in its blue. */
export const JiraIcon = ({ size = 16, className }: BrandIconProps) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <path
        fill="#2684FF"
        d="M11.99 2 4 9.99l2.66 2.66 5.33-5.33 5.34 5.33L20 9.99 11.99 2Z"
      />
      <path
        fill="#2684FF"
        opacity=".7"
        d="M11.99 11.32 9.34 14l2.65 2.66L14.65 14l-2.66-2.68Z"
      />
      <path
        fill="#2684FF"
        opacity=".5"
        d="M11.99 22 20 14.01l-2.67-2.66-5.34 5.33-5.33-5.33L4 14.01 11.99 22Z"
      />
    </svg>
  );
};

/** BambooHR — the leaf-green panda-bamboo mark, simplified to its green leaf. */
export const BambooHrIcon = ({ size = 16, className }: BrandIconProps) => {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <rect width="24" height="24" rx="5" fill="#73C41D" />
      <path
        fill="#fff"
        d="M12 5c2.2 1.2 3.4 3.2 3.4 5.6 0 1.5-.6 2.9-1.6 3.9.7.3 1.2.9 1.5 1.7-1-.4-2-.4-2.9 0 .2-1 .1-2-.4-2.9-.4 2-1.8 3.5-3.7 4.2.5-2.2 0-4.3-1.3-6 1.3.3 2.4 1 3.2 2 .2-3-.3-5.2-.2-8.5.6.6 1.4 1.4 2 2.3.1-1.7-.5-3.4-1.7-4.3.7 0 1.4.1 1.8.3Z"
      />
    </svg>
  );
};
