export const sellerListingStates = {
  DRAFT: { label: "Draft", tone: "warning" },
  SUBMITTED: { label: "In review", tone: "warning" },
  APPROVED: { label: "Approved · awaiting publication", tone: "warning" },
  REJECTED: { label: "Changes requested", tone: "warning" },
  PUBLISHED: { label: "Published", tone: "positive" },
  WITHDRAWN: { label: "Withdrawn", tone: "muted" },
} as const;
