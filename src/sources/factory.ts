import type { OAuth2Client } from 'google-auth-library';
import type { Source } from '../config/subjects.js';
import type { StateStore } from '../state/store.js';
import { EmailSource } from './emailSource.js';
import { SiteSource } from './siteSource.js';
import type { SourceFetcher } from './types.js';

export interface SourceContext {
  googleAuth: OAuth2Client;
  store: StateStore;
  userId?: number;
}

export class FetcherRegistry {
  private emailFetcher?: EmailSource;
  private siteFetcher?: SiteSource;

  constructor(private readonly ctx: SourceContext) {}

  get(source: Source): SourceFetcher {
    switch (source.type) {
      case 'email':
        this.emailFetcher ??= new EmailSource(this.ctx.googleAuth, this.ctx.store, this.ctx.userId);
        return this.emailFetcher;
      case 'site':
        this.siteFetcher ??= new SiteSource(this.ctx.store, this.ctx.userId);
        return this.siteFetcher;
    }
  }

  async close(): Promise<void> {
    if (this.siteFetcher) {
      await this.siteFetcher.close();
    }
  }
}
