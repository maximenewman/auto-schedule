import type { OAuth2Client } from 'google-auth-library';
import type { Source } from '../config/subjects.js';
import type { StateStore } from '../state/store.js';
import { EmailSource } from './emailSource.js';
import type { SourceFetcher } from './types.js';

export interface SourceContext {
  googleAuth: OAuth2Client;
  store: StateStore;
}

export function getFetcher(source: Source, ctx: SourceContext): SourceFetcher {
  switch (source.type) {
    case 'email':
      return new EmailSource(ctx.googleAuth, ctx.store);
    case 'site':
      throw new Error('site source not implemented yet (Step 7)');
  }
}
