/**
 * Minimal Canvas LMS REST client. Auth is a per-user access token the user
 * generates themselves (Canvas -> Account -> Settings -> New access token);
 * every call is a plain Bearer-token fetch against the school's Canvas
 * domain (https://canvas.sfu.ca by default).
 */
import { logger } from '../logger.js';

export class CanvasAuthError extends Error {
  constructor(message = 'Canvas token rejected — generate a new one in Canvas settings') {
    super(message);
    this.name = 'CanvasAuthError';
  }
}

export interface CanvasCourse {
  id: number;
  name: string;
  course_code: string;
  enrollment_term_id?: number;
  term?: { name?: string };
  start_at?: string | null;
  end_at?: string | null;
}

export interface CanvasAnnouncement {
  id: number;
  title: string;
  message: string; // HTML body
  html_url: string;
  posted_at: string | null;
  context_code: string; // "course_12345"
  author?: { display_name?: string };
}

export interface CanvasCalendarEvent {
  id: number;
  title: string;
  description: string | null;
  start_at: string | null;
  end_at: string | null;
  location_name?: string | null;
  context_code: string;
  html_url?: string;
  // Present when type=assignment:
  assignment?: {
    id: number;
    due_at: string | null;
    html_url?: string;
  };
}

export interface CanvasFolder {
  id: number;
  full_name: string; // "course files/lectures"
}

export interface CanvasModule {
  id: number;
  name: string;
}

export interface CanvasModuleItem {
  id: number;
  type: string; // "File" | "Page" | "Assignment" | ...
  content_id?: number; // for type=File this is the file id
  title?: string;
}

export interface CanvasFile {
  id: number;
  folder_id: number;
  display_name: string;
  filename: string;
  'content-type'?: string;
  size: number;
  url: string; // signed download URL — expires, use immediately
  updated_at: string;
}

export class CanvasClient {
  private readonly base: string;

  constructor(
    private readonly token: string,
    baseUrl: string = process.env.CANVAS_BASE_URL ?? 'https://canvas.sfu.ca',
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  /** GET one page. Throws CanvasAuthError on 401. */
  private async get<T>(path: string, params?: URLSearchParams): Promise<{ data: T; next: string | null }> {
    const url = path.startsWith('http')
      ? path
      : `${this.base}/api/v1${path}${params && [...params].length > 0 ? `?${params}` : ''}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 401) throw new CanvasAuthError();
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`canvas: HTTP ${res.status} on ${path} ${body.slice(0, 200)}`);
    }
    return { data: (await res.json()) as T, next: nextLink(res.headers.get('link')) };
  }

  /** Follow rel="next" Link headers until the collection is exhausted. */
  private async getAll<T>(path: string, params: URLSearchParams): Promise<T[]> {
    params.set('per_page', '100');
    const out: T[] = [];
    let page = await this.get<T[]>(path, params);
    out.push(...page.data);
    while (page.next) {
      page = await this.get<T[]>(page.next);
      out.push(...page.data);
    }
    return out;
  }

  /** Validates the token; returns the Canvas user's name. */
  async whoAmI(): Promise<{ id: number; name: string }> {
    const { data } = await this.get<{ id: number; name: string }>('/users/self');
    return data;
  }

  async listActiveCourses(): Promise<CanvasCourse[]> {
    const params = new URLSearchParams({ enrollment_state: 'active' });
    params.append('include[]', 'term');
    return this.getAll<CanvasCourse>('/courses', params);
  }

  /**
   * Announcements across courses. Canvas caps context_codes per request, so
   * chunk by 10; default window is only 14 days back, so pass startDate
   * (e.g. term start) explicitly.
   */
  async listAnnouncements(courseIds: number[], startDate: string): Promise<CanvasAnnouncement[]> {
    const out: CanvasAnnouncement[] = [];
    for (const chunk of chunks(courseIds, 10)) {
      const params = new URLSearchParams({ start_date: startDate });
      for (const id of chunk) params.append('context_codes[]', `course_${id}`);
      out.push(...(await this.getAll<CanvasAnnouncement>('/announcements', params)));
    }
    return out;
  }

  /** Calendar events or assignment due dates for the given courses. */
  async listCalendarEvents(
    courseIds: number[],
    type: 'event' | 'assignment',
    window: { startDate: string; endDate: string },
  ): Promise<CanvasCalendarEvent[]> {
    const out: CanvasCalendarEvent[] = [];
    for (const chunk of chunks(courseIds, 10)) {
      const params = new URLSearchParams({
        type,
        start_date: window.startDate,
        end_date: window.endDate,
      });
      for (const id of chunk) params.append('context_codes[]', `course_${id}`);
      out.push(...(await this.getAll<CanvasCalendarEvent>('/calendar_events', params)));
    }
    return out;
  }

  /** 403 (course hides the Files tab) surfaces as `null`, not an error. */
  async listCourseFiles(courseId: number): Promise<CanvasFile[] | null> {
    try {
      return await this.getAll<CanvasFile>(`/courses/${courseId}/files`, new URLSearchParams());
    } catch (err) {
      if (err instanceof CanvasAuthError) throw err;
      if (/HTTP 403/.test((err as Error).message)) {
        logger.info({ courseId }, 'canvas: files tab not accessible — skipping');
        return null;
      }
      throw err;
    }
  }

  async listCourseFolders(courseId: number): Promise<CanvasFolder[]> {
    try {
      return await this.getAll<CanvasFolder>(`/courses/${courseId}/folders`, new URLSearchParams());
    } catch (err) {
      if (err instanceof CanvasAuthError) throw err;
      return [];
    }
  }

  // Many courses hide the Files tab (403) but still distribute files through
  // Modules — walking module items of type "File" recovers them.

  async listModules(courseId: number): Promise<CanvasModule[]> {
    try {
      return await this.getAll<CanvasModule>(`/courses/${courseId}/modules`, new URLSearchParams());
    } catch (err) {
      if (err instanceof CanvasAuthError) throw err;
      return [];
    }
  }

  async listModuleItems(courseId: number, moduleId: number): Promise<CanvasModuleItem[]> {
    try {
      return await this.getAll<CanvasModuleItem>(
        `/courses/${courseId}/modules/${moduleId}/items`,
        new URLSearchParams(),
      );
    } catch (err) {
      if (err instanceof CanvasAuthError) throw err;
      return [];
    }
  }

  /** Single file by id (works for module-visible files even when the Files
   *  tab is hidden). Locked/inaccessible files return null. */
  async getCourseFile(courseId: number, fileId: number): Promise<CanvasFile | null> {
    try {
      const { data } = await this.get<CanvasFile>(`/courses/${courseId}/files/${fileId}`);
      return data;
    } catch (err) {
      if (err instanceof CanvasAuthError) throw err;
      return null;
    }
  }
}

/** Parse the RFC-5988 Link header Canvas uses for pagination. */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
