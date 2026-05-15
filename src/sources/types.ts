import type { Source, Subject } from '../config/subjects.js';

export interface AttachmentRef {
  url: string;
  filename: string;
  /** Opaque hint sources can use to refetch (e.g. Gmail attachmentId). */
  meta?: Record<string, string>;
}

export interface SourceItem {
  /** Stable per-source identifier  -  Gmail message ID or normalized site URL. */
  sourceItemId: string;
  /** Normalized text the agent will reason over. */
  content: string;
  attachments: AttachmentRef[];
  /** Free-form metadata for logging / downstream auth. */
  meta?: Record<string, string>;
}

export interface SourceFetcher {
  fetchNew(subject: Subject, source: Source): Promise<SourceItem[]>;
  /** Called after the pipeline finished processing an item successfully. */
  markProcessed(subject: Subject, source: Source, item: SourceItem): Promise<void> | void;
}
