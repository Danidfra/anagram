import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { parseLinkPreview, parseOEmbedPreview, previewUrl } from '../../src/utils/linkPreview';
import { loadLinkPreview, clearLinkPreviews } from '../../src/services/linkPreviewService';

beforeEach(() => vi.stubGlobal('window', {}));

afterEach(() => {
  clearLinkPreviews();
  vi.unstubAllGlobals();
});
describe('link previews', () => {
  it('reads Open Graph text and entities while ignoring images and scripts', () => {
    const result = parseLinkPreview(
      `<head><script>"<meta property='og:title' content='Wrong'>"</script>
      <!-- <meta property="og:title" content="Comment"> -->
      <meta content='Anagram &amp; friends' property='og:title'>
      <meta name="description" content="Fallback"><meta property="og:description" content="Public &#x1F310; &quot;chat&quot;">
      <meta property="og:image" content="/cover.png"><meta property="og:site_name" content="Example"></head>`,
      'https://example.org/post',
    );
    expect(result).toEqual({
      title: 'Anagram & friends',
      description: 'Public 🌐 "chat"',
      site: 'Example',
    });
  });
  it('uses Twitter/title fallbacks', () => {
    expect(parseLinkPreview('<title>Plain &lt;title&gt;</title>', 'https://example.org')).toEqual({
      title: 'Plain <title>',
      description: '',
      site: 'example.org',
    });
    expect(
      parseLinkPreview(
        '<meta name="twitter:title" content="Social card"><meta name="twitter:image" content="javascript:alert(1)">',
        'https://example.org',
      )?.title,
    ).toBe('Social card');
    expect(parseLinkPreview('<p>No metadata</p>', 'https://example.org')).toBeNull();
  });
  it.each([
    '',
    'http://example.org',
    'https://user:secret@example.org',
    'https://localhost',
    'https://localhost.',
    'https://printer.local.',
    'https://127.1',
    'https://0x7f000001',
    'https://127.0.0.1',
    'https://2130706433',
    'https://0177.0.0.1',
    'https://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::ffff:127.0.0.1]',
    'https://metadata.google.internal',
    'https://router.home.arpa',
    'https://printer.lan',
    'https://[::1]',
    'https://printer.local',
    'https://example.org:444/path',
    'data:text/html,test',
    'javascript:alert(1)',
    'https://example.org/nsec1secret',
    'https://example.org/%6esec1secret',
    'https://example.org/%256esec1secret',
    'https://example.org/%',
    'https://example.org/' + 'a'.repeat(4096),
  ])('does not fetch unsafe target %s', async (value) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(previewUrl(value)).toBeNull();
    expect(await loadLinkPreview(value)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never performs preview requests in a server environment', async () => {
    vi.stubGlobal('window', undefined);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(await loadLinkPreview('https://example.org/server')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('bounds malformed metadata and ignores unterminated script/comment contents', () => {
    const source = 'https://example.org';
    expect(parseLinkPreview('<meta '.repeat(40000), source)).toBeNull();
    expect(parseLinkPreview(`<meta ${'x'.repeat(260000)}>`, source)).toBeNull();
    for (const prefix of ['<!--', '<script>']) {
      expect(
        parseLinkPreview(`${prefix}<meta property="og:title" content="Hidden">`, source),
      ).toBeNull();
    }
    expect(
      parseLinkPreview(
        '<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;">',
        source,
      )?.title,
    ).toBe('<img src=x onerror=alert(1)>');
  });
  it('cancels active and queued requests and discards cached URLs on logout', async () => {
    const fetcher = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const pending = Array.from({ length: 8 }, (_, i) =>
      loadLinkPreview(`https://example.org/pending-${i}`),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    clearLinkPreviews();
    expect(await Promise.all(pending)).toEqual(Array(8).fill(null));
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<title>New session</title>', {
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    expect((await loadLinkPreview('https://example.org/pending-0'))?.title).toBe('New session');
  });
  it('does not truncate GitHub JSON at a head tag inside the description', async () => {
    const json = JSON.stringify({
      private: false,
      full_name: 'example/repo',
      description: '</head> text',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of [json.slice(0, -4), json.slice(-4)])
                controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
        ),
      ),
    );
    expect((await loadLinkPreview('https://github.com/example/repo'))?.description).toBe(
      '</head> text',
    );
  });
  it('deduplicates requests and omits credentials and referrers', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response('<title>Shared preview</title>', { headers: { 'content-type': 'text/html' } }),
      );
    vi.stubGlobal('fetch', fetcher);
    const [a, b] = await Promise.all([
      loadLinkPreview('https://example.org/dedup#one'),
      loadLinkPreview('https://example.org/dedup#two'),
    ]);
    expect(a?.title).toBe('Shared preview');
    expect(b).toEqual(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.org/dedup',
      expect.objectContaining({
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      }),
    );
  });
  it('renders public GitHub repository metadata and keeps the branch label', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            private: false,
            full_name: 'lnbits/anagram',
            description: 'Nostr chat',
            owner: { avatar_url: 'https://avatars.githubusercontent.com/u/1' },
          }),
        ),
      ),
    );
    expect(await loadLinkPreview('https://github.com/lnbits/anagram/tree/brutal')).toEqual({
      title: 'lnbits/anagram at brutal',
      description: 'Nostr chat',
      site: 'GitHub',
    });
  });
  it.each([
    'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=10&si=tracking',
    'https://youtu.be/jNQXAC9IVRw?si=tracking',
    'https://m.youtube.com/watch?v=jNQXAC9IVRw',
    'https://youtube.com/shorts/jNQXAC9IVRw',
    'https://www.youtube.com/live/jNQXAC9IVRw',
    'https://www.youtube.com/embed/jNQXAC9IVRw',
  ])(
    'loads video metadata through YouTube for %s without players or tracking parameters',
    async (url) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            title: 'Video title',
            author_name: 'Channel',
            thumbnail_url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
            html: '<iframe src="https://youtube.com/embed/jNQXAC9IVRw"></iframe>',
          }),
        ),
      );
      vi.stubGlobal('fetch', fetcher);
      expect(await loadLinkPreview(url)).toEqual({
        title: 'Video title',
        description: 'Channel',
        site: 'YouTube',
      });
      expect(fetcher).toHaveBeenCalledOnce();
      const endpoint = new URL(fetcher.mock.calls[0][0]);
      expect(endpoint.origin + endpoint.pathname).toBe('https://www.youtube.com/oembed');
      expect(endpoint.searchParams.get('url')).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      expect(fetcher.mock.calls[0][1]).toMatchObject({
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
      });
    },
  );
  it.each(['https://x.com/jack/status/20?s=20', 'https://twitter.com/jack/status/20/photo/1'])(
    'loads only text metadata for an X post %s',
    async (url) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            author_name: 'jack',
            html: '<blockquote><p>Hello &amp; welcome<br>to <a href="https://example.org">Nostr</a></p><script>bad()</script></blockquote>',
          }),
        ),
      );
      vi.stubGlobal('fetch', fetcher);
      expect(await loadLinkPreview(url)).toEqual({
        title: 'jack on X',
        description: 'Hello & welcome to Nostr',
        site: 'X',
      });
      const endpoint = new URL(fetcher.mock.calls[0][0]);
      expect(endpoint.origin + endpoint.pathname).toBe('https://publish.x.com/oembed');
      expect(endpoint.searchParams.get('url')).toBe('https://x.com/jack/status/20');
      expect(endpoint.searchParams.get('omit_script')).toBe('true');
      expect(endpoint.searchParams.get('dnt')).toBe('true');
    },
  );
  it('validates oEmbed metadata and ignores thumbnails and embed HTML', () => {
    for (const value of [null, [], {}, { title: 12 }, { html: '<iframe></iframe>' }])
      expect(parseOEmbedPreview(value, 'YouTube')).toBeNull();
    expect(
      parseOEmbedPreview(
        {
          title: '<script>Text only</script>',
          thumbnail_url: 'https://127.0.0.1/private',
          html: '<img src="https://example.org/tracker">',
        },
        'YouTube',
      ),
    ).toEqual({ title: '<script>Text only</script>', description: '', site: 'YouTube' });
    expect(
      parseOEmbedPreview(
        {
          author_name: 'Name',
          html: '<script><p>Hidden</p></script><!--<p>Hidden</p>--><p>&lt;img src=x onerror=alert(1)&gt;</p>',
        },
        'X',
      )?.description,
    ).toBe('<img src=x onerror=alert(1)>');
  });
  it('bounds malformed post HTML without repeatedly rescanning paragraphs or tags', () => {
    expect(
      parseOEmbedPreview({ author_name: 'Name', html: '<p>'.repeat(80000) }, 'X')?.description,
    ).toBe('Name');
    expect(
      parseOEmbedPreview({ author_name: 'Name', html: '<p>' + '<'.repeat(250000) + '</p>' }, 'X')
        ?.description,
    ).toHaveLength(360);
  });
  it('does not send lookalike YouTube domains to a provider endpoint', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('CORS'));
    vi.stubGlobal('fetch', fetcher);
    await loadLinkPreview('https://youtube.com.example.org/watch?v=jNQXAC9IVRw');
    expect(fetcher).toHaveBeenCalledWith(
      'https://youtube.com.example.org/watch?v=jNQXAC9IVRw',
      expect.anything(),
    );
  });
  it('shares repeated video requests and bounds a burst to three active fetches', async () => {
    const fetcher = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const repeated = Array.from({ length: 20 }, () =>
      loadLinkPreview('https://youtu.be/jNQXAC9IVRw'),
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const burst = Array.from({ length: 40 }, (_, i) =>
      loadLinkPreview(`https://youtu.be/${String(i).padStart(11, '0')}`),
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    clearLinkPreviews();
    expect(await Promise.all([...repeated, ...burst])).toEqual(Array(60).fill(null));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('leaves unavailable videos as plain links and caches the failed lookup', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('Unavailable', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const url = 'https://youtu.be/jNQXAC9IVRw';
    expect(await loadLinkPreview(url)).toBeNull();
    expect(await loadLinkPreview(url)).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('silently falls back to the original link on fetch failure or oversized HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('CORS')));
    expect(await loadLinkPreview('https://example.org/cors')).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('a'.repeat(262145), { headers: { 'content-type': 'text/html' } }),
        ),
    );
    expect(await loadLinkPreview('https://example.org/huge')).toBeNull();
  });
});
