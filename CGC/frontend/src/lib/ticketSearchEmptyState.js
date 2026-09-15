/**
 * What the tickets table says when a search finds nothing.
 *
 * Search only looks inside the tab and filters that are already set. A valid
 * ticket number searched with the Source filter still on WhatsApp showed only
 * "No tickets match", with nothing on screen to say the filter was the reason —
 * which reads as search being broken. So an empty search now names the filters
 * it was limited by and offers to drop them.
 */

const TAB_LABELS = {
  UNLINKED: 'the Unlinked tab',
  LINKED: 'the Linked tab',
};

const SOURCE_LABELS = {
  WHATSAPP: 'WhatsApp',
  EMAIL: 'Email',
  MANUAL: 'Manual Upload',
};

/** Everything besides the search box that is narrowing the list, as labels. */
export function narrowingTicketFilters({
  activeTab,
  supplierId,
  supplierName,
  source,
  startDate,
  endDate,
} = {}) {
  const filters = [];
  if (TAB_LABELS[activeTab]) filters.push(TAB_LABELS[activeTab]);
  if (supplierId) filters.push(supplierName ? `supplier ${supplierName}` : 'a supplier');
  if (source) filters.push(`source ${SOURCE_LABELS[source] || source}`);
  if (startDate || endDate) filters.push('a date range');
  return filters;
}

/**
 * Title and message for the empty table, and whether to offer searching every
 * ticket instead.
 */
export function ticketsEmptyState({ search, filters = [] } = {}) {
  const term = (search || '').trim();

  if (term && filters.length > 0) {
    return {
      title: `No tickets match "${term}" with these filters`,
      message: `Still filtering by ${filters.join(', ')}.`,
      offerSearchAll: true,
    };
  }

  if (term) {
    return {
      title: `No tickets match "${term}"`,
      message: 'Search looks at the ticket #, PO, material and supplier.',
      offerSearchAll: false,
    };
  }

  return {
    title: 'No tickets match',
    message: 'Try another tab, search, or date range — or upload a ticket photo.',
    offerSearchAll: false,
  };
}
