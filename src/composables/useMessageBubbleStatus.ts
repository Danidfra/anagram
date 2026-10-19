import { t } from '#src/i18n.ts';
import type { Message, MessageRelayStatus } from '#src/types/chat.ts';
import { isMessageRelayStatus } from '#src/utils/messageRelayStatus.ts';
import { uniqueRelayUrls } from '#src/utils/relayUrls.ts';

export interface StatusSegment {
  key:
    | 'published'
    | 'published-recipient'
    | 'published-self'
    | 'pending'
    | 'failed'
    | 'received'
    | 'missing';
  className: string;
  weight: number;
}

export type RetryableStatusScope = 'recipient' | 'self';
export type StatusListScope = MessageRelayStatus['scope'] | 'derived';

export interface StatusListItem {
  key: string;
  relayUrl: string;
  detail?: string;
  dotClass: string;
  scope: StatusListScope;
  status: StatusSegment['key'];
  retryable: boolean;
}

export interface StatusSection {
  key: string;
  title: string;
  tabLabel?: string;
  successCount?: number;
  totalCount?: number;
  retryableCount?: number;
  items: StatusListItem[];
  emptyLabel: string;
}

function formatRelayStatusItem(relayStatus: Pick<MessageRelayStatus, 'relay_url'>): string {
  return relayStatus.relay_url;
}

function getStatusSegmentClassName(status: StatusSegment['key']): string {
  switch (status) {
    case 'published':
    case 'published-recipient':
    case 'received':
      return 'bubble__status-segment--green';
    case 'published-self':
      return 'bubble__status-segment--blue';
    case 'failed':
      return 'bubble__status-segment--red';
    default:
      return 'bubble__status-segment--gray';
  }
}

function getStatusDotClassName(
  status: StatusListItem['status'],
  scope: StatusListScope = 'derived',
): string {
  switch (status) {
    case 'published':
      return scope === 'self' ? 'bubble__status-list-dot--blue' : 'bubble__status-list-dot--green';
    case 'received':
      return 'bubble__status-list-dot--green';
    case 'failed':
      return 'bubble__status-list-dot--red';
    default:
      return 'bubble__status-list-dot--gray';
  }
}

function buildStatusListItems(
  relayStatuses: MessageRelayStatus[],
  predicate: (relayStatus: MessageRelayStatus) => boolean,
): StatusListItem[] {
  const statusPriority: Record<'published' | 'failed' | 'pending', number> = {
    published: 0,
    failed: 1,
    pending: 2,
  };

  return relayStatuses
    .filter(
      (
        relayStatus,
      ): relayStatus is MessageRelayStatus & {
        status: 'published' | 'failed' | 'pending';
      } =>
        predicate(relayStatus) &&
        (relayStatus.status === 'published' ||
          relayStatus.status === 'failed' ||
          relayStatus.status === 'pending'),
    )
    .slice()
    .sort((first, second) => {
      const byStatus = statusPriority[first.status] - statusPriority[second.status];
      if (byStatus !== 0) {
        return byStatus;
      }

      return first.relay_url.localeCompare(second.relay_url);
    })
    .map((relayStatus) => ({
      key: `${relayStatus.status}-${relayStatus.scope}-${relayStatus.relay_url}`,
      relayUrl: formatRelayStatusItem(relayStatus),
      detail: relayStatus.detail,
      dotClass: getStatusDotClassName(relayStatus.status, relayStatus.scope),
      scope: relayStatus.scope,
      status: relayStatus.status,
      retryable: relayStatus.status === 'failed',
    }));
}

function buildStatusTabLabel(title: string, successCount: number, totalCount: number): string {
  return `${title} (${successCount}/${totalCount})`;
}

function countPublishedItems(items: StatusListItem[]): number {
  return items.filter((item) => item.status === 'published').length;
}

function countRetryableItems(items: StatusListItem[]): number {
  return items.filter((item) => item.retryable && isRetryableStatusScope(item.scope)).length;
}

function buildOutboundStatusSection(
  key: RetryableStatusScope,
  title: string,
  items: StatusListItem[],
): StatusSection {
  const successCount = countPublishedItems(items);
  const totalCount = items.length;

  return {
    key,
    title,
    tabLabel: buildStatusTabLabel(title, successCount, totalCount),
    successCount,
    totalCount,
    retryableCount: countRetryableItems(items),
    items,
    emptyLabel: t('relays.empty.noRelays'),
  };
}

export function isRetryableStatusScope(scope: StatusListScope): scope is RetryableStatusScope {
  return scope === 'recipient' || scope === 'self';
}

// A per-render projection: creating derived signals here would retain the calling UI.
export function useMessageBubbleStatus(options: {
  contactName: string;
  contactRelayUrls: string[];
  isMine: boolean;
  message: Readonly<Message>;
}) {
  const relayStatuses = (() => {
    const value = options.message.nostrEvent?.relay_statuses;
    if (!Array.isArray(value)) {
      return [] as MessageRelayStatus[];
    }

    return value.filter(isMessageRelayStatus).sort((first, second) => {
      const byRelayUrl = first.relay_url.localeCompare(second.relay_url);
      if (byRelayUrl !== 0) {
        return byRelayUrl;
      }

      const byDirection = first.direction.localeCompare(second.direction);
      if (byDirection !== 0) {
        return byDirection;
      }

      return first.scope.localeCompare(second.scope);
    });
  })();

  const outboundRelayStatuses = relayStatuses.filter(
    (relayStatus) => relayStatus.direction === 'outbound',
  );

  const inboundReceivedRelayStatuses = relayStatuses.filter(
    (
      relayStatus,
    ): relayStatus is MessageRelayStatus & {
      direction: 'inbound';
      status: 'received';
    } => relayStatus.direction === 'inbound' && relayStatus.status === 'received',
  );

  const normalizedContactRelayUrls = uniqueRelayUrls(options.contactRelayUrls);

  const inboundReceivedRelayUrls = (() => {
    const uniqueRelayUrlSet = new Set<string>();

    for (const relayStatus of inboundReceivedRelayStatuses) {
      const relayUrl = formatRelayStatusItem(relayStatus).trim();
      if (!relayUrl) {
        continue;
      }

      uniqueRelayUrlSet.add(relayUrl);
    }

    return Array.from(uniqueRelayUrlSet).sort((first, second) => first.localeCompare(second));
  })();

  const inboundReceivedRelayUrlSet = new Set(inboundReceivedRelayUrls);

  const inboundMissingRelayUrls = normalizedContactRelayUrls.filter(
    (relayUrl) => !inboundReceivedRelayUrlSet.has(relayUrl),
  );

  const hasPendingRelayStatuses = outboundRelayStatuses.some(
    (relayStatus) => relayStatus.status === 'pending',
  );

  // Restored copies of our own messages have inbound observations, not the
  // sending device's publish acknowledgements. Keep that evidence visible.
  const showOutboundStatus = options.isMine && outboundRelayStatuses.length > 0;
  const hasRelayStatuses = showOutboundStatus || inboundReceivedRelayUrls.length > 0;

  const contactRelaysTitle = t('relays.contactTitle', {
    name: options.contactName || t('contacts.contact.label'),
  });

  const outboundContactRelaysTitle = t('relays.contactRelays');
  const outboundMyRelaysTitle = t('relays.myRelays');

  const statusDialogTitle = showOutboundStatus
    ? t('relays.relayStatus')
    : t('relays.receivedRelayStatus');

  const statusSegments: StatusSegment[] = ((): StatusSegment[] => {
    if (!showOutboundStatus) {
      const segments: StatusSegment[] = [
        {
          key: 'received',
          className: getStatusSegmentClassName('received'),
          weight: inboundReceivedRelayUrls.length,
        },
        {
          key: 'missing',
          className: getStatusSegmentClassName('missing'),
          weight: options.isMine ? 0 : inboundMissingRelayUrls.length,
        },
      ];

      return segments.filter((segment) => segment.weight > 0);
    }

    function countByStatus(
      status: MessageRelayStatus['status'],
      scope?: MessageRelayStatus['scope'],
    ) {
      return outboundRelayStatuses.filter((relayStatus) => {
        if (relayStatus.status !== status) {
          return false;
        }

        return scope ? relayStatus.scope === scope : true;
      }).length;
    }

    const publishedRecipient = countByStatus('published', 'recipient');
    const publishedSelf = countByStatus('published', 'self');
    const pending = countByStatus('pending');
    const failed = countByStatus('failed');

    const segments: StatusSegment[] = [
      {
        key: 'published-recipient',
        className: getStatusSegmentClassName('published-recipient'),
        weight: publishedRecipient,
      },
      {
        key: 'published-self',
        className: getStatusSegmentClassName('published-self'),
        weight: publishedSelf,
      },
      {
        key: 'pending',
        className: getStatusSegmentClassName('pending'),
        weight: pending,
      },
      {
        key: 'failed',
        className: getStatusSegmentClassName('failed'),
        weight: failed,
      },
    ];

    return segments.filter((segment) => segment.weight > 0);
  })();

  function buildSections(): StatusSection[] {
    const contactStatusListItems: StatusListItem[] = buildStatusListItems(
      outboundRelayStatuses,
      (relayStatus) => relayStatus.scope === 'recipient',
    );

    const myStatusListItems: StatusListItem[] = buildStatusListItems(
      outboundRelayStatuses,
      (relayStatus) => relayStatus.scope === 'self',
    );

    const inboundContactStatusListItems: StatusListItem[] = normalizedContactRelayUrls.map(
      (relayUrl) => {
        const status: StatusListItem['status'] = inboundReceivedRelayUrlSet.has(relayUrl)
          ? 'received'
          : 'missing';

        return {
          key: `${status}-contact-${relayUrl}`,
          relayUrl,
          detail: status === 'missing' ? t('relays.messageReceivedRelay') : undefined,
          dotClass: getStatusDotClassName(status),
          scope: 'derived',
          status,
          retryable: false,
        };
      },
    );

    const inboundReceivedStatusListItems: StatusListItem[] = inboundReceivedRelayUrls.map(
      (relayUrl) => ({
        key: `received-${relayUrl}`,
        relayUrl,
        dotClass: getStatusDotClassName('received'),
        scope: 'subscription',
        status: 'received',
        retryable: false,
      }),
    );

    const inboundExtraReceivedStatusListItems: StatusListItem[] = ((): StatusListItem[] => {
      const contactRelayUrlSet = new Set(normalizedContactRelayUrls);

      return inboundReceivedRelayUrls
        .filter((relayUrl) => !contactRelayUrlSet.has(relayUrl))
        .map((relayUrl) => ({
          key: `received-extra-${relayUrl}`,
          relayUrl,
          detail: t('relays.receivedRelayOutsideContact'),
          dotClass: getStatusDotClassName('received'),
          scope: 'subscription',
          status: 'received',
          retryable: false,
        }));
    })();

    const statusSections: StatusSection[] = ((): StatusSection[] => {
      if (showOutboundStatus) {
        return [
          buildOutboundStatusSection(
            'recipient',
            outboundContactRelaysTitle,
            contactStatusListItems,
          ),
          buildOutboundStatusSection('self', outboundMyRelaysTitle, myStatusListItems),
        ];
      }

      if (!options.isMine && normalizedContactRelayUrls.length > 0) {
        const sections: StatusSection[] = [
          {
            key: 'contact',
            title: contactRelaysTitle,
            items: inboundContactStatusListItems,
            emptyLabel: t('relays.empty.noRelays'),
          },
        ];

        if (inboundExtraReceivedStatusListItems.length > 0) {
          sections.push({
            key: 'extra-received',
            title: t('relays.otherReceivedRelays'),
            items: inboundExtraReceivedStatusListItems,
            emptyLabel: t('relays.empty.noRelays'),
          });
        }

        return sections;
      }

      return inboundReceivedStatusListItems.length > 0
        ? [
            {
              key: 'received',
              title: t('common.received'),
              items: inboundReceivedStatusListItems,
              emptyLabel: t('relays.empty.noRelays'),
            },
          ]
        : [];
    })();
    return statusSections;
  }

  return {
    showOutboundStatus,
    hasPendingRelayStatuses,
    hasRelayStatuses,
    statusDialogTitle,
    get statusSections() {
      return buildSections();
    },
    statusSegments,
  };
}
