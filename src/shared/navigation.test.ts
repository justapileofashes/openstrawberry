import { describe, expect, it } from "vitest";
import { BLANK_PAGE } from "./desktop-shell.js";
import {
  buildSearchUrl,
  DEFAULT_SEARCH_TEMPLATE,
  displayHostname,
  isAllowedUrl,
  isLocalDocumentUrl,
  isSafeFaviconUrl,
  LOCAL_DOCUMENT_EXTENSIONS,
  localDocumentArgument,
  MAX_ADDRESS_LENGTH,
  normalizeAddressInput,
  resolveSearchTemplate,
  searchTemplateForName,
  urlFromCommandLine
} from "./navigation.js";

describe("isAllowedUrl", () => {
  it("allows HTTP and HTTPS", () => {
    expect(isAllowedUrl("https://example.com/")).toBe(true);
    expect(isAllowedUrl("http://localhost:3000/")).toBe(true);
  });

  it("allows exactly the neutral internal page", () => {
    expect(isAllowedUrl(BLANK_PAGE)).toBe(true);
  });

  it("refuses anything that merely resembles the internal page", () => {
    for (const value of ["about:blank#x", "about:blank?a=1", "about:srcdoc", "about:config", "ABOUT:BLANK"]) {
      expect(isAllowedUrl(value)).toBe(false);
    }
  });

  it("refuses unsafe schemes", () => {
    for (const value of [
      "file:///C:/Windows/System32/",
      "file:///etc/passwd",
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://example.com/uuid",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "ws://example.com",
      "ftp://example.com"
    ]) {
      expect(isAllowedUrl(value)).toBe(false);
    }
  });

  it("refuses URLs carrying embedded credentials", () => {
    expect(isAllowedUrl("https://user:pass@example.com/")).toBe(false);
    expect(isAllowedUrl("https://user@example.com/")).toBe(false);
  });

  it("refuses hostless and unparseable URLs", () => {
    expect(isAllowedUrl("https://")).toBe(false);
    expect(isAllowedUrl("not a url")).toBe(false);
    expect(isAllowedUrl("")).toBe(false);
  });
});

describe("normalizeAddressInput", () => {
  it("keeps explicit HTTPS input navigable, including example.com", () => {
    // Regression guard: only implicit startup defaults changed away from the
    // example domain. Deliberately typing it must still work.
    expect(normalizeAddressInput("https://example.com")).toEqual({
      kind: "navigate",
      url: "https://example.com/"
    });
  });

  it("adds https to a bare hostname", () => {
    expect(normalizeAddressInput("example.com")).toEqual({
      kind: "navigate",
      url: "https://example.com/"
    });
    expect(normalizeAddressInput("sub.example.co.uk/path?q=1")).toEqual({
      kind: "navigate",
      url: "https://sub.example.co.uk/path?q=1"
    });
  });

  it("uses http for loopback hosts so local development works", () => {
    expect(normalizeAddressInput("localhost:5173")).toEqual({
      kind: "navigate",
      url: "http://localhost:5173/"
    });
    expect(normalizeAddressInput("127.0.0.1:8080")).toEqual({
      kind: "navigate",
      url: "http://127.0.0.1:8080/"
    });
  });

  it("passes the neutral internal page through", () => {
    expect(normalizeAddressInput(" about:blank ")).toEqual({
      kind: "navigate",
      url: BLANK_PAGE
    });
  });

  it("refuses disallowed schemes rather than silently searching for them", () => {
    // Rewriting these into a search would hide the refusal from the user.
    for (const value of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      expect(normalizeAddressInput(value)).toEqual({
        kind: "rejected",
        reason: "That address scheme is not allowed."
      });
    }
  });

  it("treats free text as a search", () => {
    const decision = normalizeAddressInput("how to build an electron browser");
    expect(decision.kind).toBe("navigate");
    if (decision.kind === "navigate") {
      expect(decision.url).toBe(
        "https://www.google.com/search?q=how%20to%20build%20an%20electron%20browser"
      );
    }
  });

  it("treats a dotless word and a bare number as searches, not hosts", () => {
    for (const value of ["chocolate", "3.5", "hello world"]) {
      const decision = normalizeAddressInput(value);
      expect(decision.kind).toBe("navigate");
      if (decision.kind === "navigate") expect(decision.url).toContain("www.google.com/search");
    }
  });

  it("rejects empty and over-long input", () => {
    expect(normalizeAddressInput("   ").kind).toBe("rejected");
    expect(normalizeAddressInput("a".repeat(MAX_ADDRESS_LENGTH + 1)).kind).toBe("rejected");
  });

  it("honours a caller-supplied search template", () => {
    const decision = normalizeAddressInput("privacy", "https://search.example/?query=%s");
    expect(decision).toEqual({
      kind: "navigate",
      url: "https://search.example/?query=privacy"
    });
  });
});

describe("buildSearchUrl", () => {
  it("encodes the query", () => {
    expect(buildSearchUrl("a&b=c d")).toBe("https://www.google.com/search?q=a%26b%3Dc%20d");
  });
});

describe("isSafeFaviconUrl", () => {
  it("accepts only HTTPS favicons", () => {
    expect(isSafeFaviconUrl("https://example.com/favicon.ico")).toBe(true);
  });

  it("refuses plaintext, local, inline, and script favicons", () => {
    for (const value of [
      "http://example.com/favicon.ico",
      "file:///C:/icon.png",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "javascript:alert(1)",
      "",
      null,
      undefined
    ]) {
      expect(isSafeFaviconUrl(value)).toBe(false);
    }
  });
});

describe("urlFromCommandLine", () => {
  it("finds a URL appended by the desktop shell", () => {
    expect(
      urlFromCommandLine(["C:/Program Files/OpenStrawberry/OpenStrawberry.exe", "https://example.com/"])
    ).toBe("https://example.com/");
  });

  it("ignores the executable path and the app directory", () => {
    expect(urlFromCommandLine(["/usr/bin/openstrawberry", "."])).toBeNull();
    expect(urlFromCommandLine(["electron.exe", "D:\\repo\\openstrawberry"])).toBeNull();
  });

  it("never treats a switch as a URL", () => {
    expect(
      urlFromCommandLine(["app.exe", "--remote-debugging-port=9222", "--inspect"])
    ).toBeNull();
  });

  it("refuses schemes the navigation policy rejects", () => {
    for (const argument of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pass@example.com/"
    ]) {
      expect(urlFromCommandLine(["app.exe", argument])).toBeNull();
    }
  });

  it("returns the first acceptable URL only", () => {
    expect(
      urlFromCommandLine(["app.exe", "https://first.example/", "https://second.example/"])
    ).toBe("https://first.example/");
  });

  it("handles an empty argument list", () => {
    expect(urlFromCommandLine([])).toBeNull();
  });
});

describe("isLocalDocumentUrl", () => {
  it("stays out of isAllowedUrl, so nothing else in the browser widens with it", () => {
    // The whole safety property. The address bar, will-navigate, and session
    // restore all ask isAllowedUrl, and none of them may reach the disk.
    const document = "file:///C:/Users/ashton/notes.html";
    expect(isLocalDocumentUrl(document)).toBe(true);
    expect(isAllowedUrl(document)).toBe(false);
  });

  it("opens the document types the installer registers, and no others", () => {
    for (const extension of LOCAL_DOCUMENT_EXTENSIONS) {
      expect(isLocalDocumentUrl(`file:///C:/tmp/page${extension}`)).toBe(true);
    }
    // Perfectly valid file: URLs that the registration never claimed.
    expect(isLocalDocumentUrl("file:///C:/Users/ashton/.ssh/id_ed25519")).toBe(false);
    expect(isLocalDocumentUrl("file:///C:/Windows/System32/config/SAM")).toBe(false);
    expect(isLocalDocumentUrl("file:///C:/")).toBe(false);
  });

  it("refuses a UNC path, which is a network fetch wearing a local scheme", () => {
    expect(isLocalDocumentUrl("file://attacker.example/share/page.html")).toBe(false);
  });

  it("judges the real end of the path, not an extension buried in it", () => {
    expect(isLocalDocumentUrl("file:///C:/tmp/page.html.exe")).toBe(false);
    expect(isLocalDocumentUrl("file:///C:/tmp/.html")).toBe(true);
  });

  it("reads the path rather than the query, which is not part of the filename", () => {
    // The document here really is page.html. A query on a file: URL is inert,
    // and refusing it would refuse a legitimate relative link from one local
    // page to another.
    expect(isLocalDocumentUrl("file:///C:/tmp/page.html?x=1")).toBe(true);
    expect(isLocalDocumentUrl("file:///C:/tmp/archive.zip?name=x.html")).toBe(false);
  });

  it("refuses an undecodable or null-bearing path rather than guessing", () => {
    expect(isLocalDocumentUrl("file:///C:/tmp/%ZZ.html")).toBe(false);
    expect(isLocalDocumentUrl("file:///C:/tmp/page%00.html")).toBe(false);
  });

  it("refuses every other scheme, including ones that embed a filename", () => {
    expect(isLocalDocumentUrl("https://example.com/page.html")).toBe(false);
    expect(isLocalDocumentUrl("javascript:alert(1)//page.html")).toBe(false);
    expect(isLocalDocumentUrl(BLANK_PAGE)).toBe(false);
  });
});

describe("localDocumentArgument", () => {
  it("finds the document a double-click passes on the command line", () => {
    expect(localDocumentArgument(["OpenStrawberry.exe", "C:\\Users\\ashton\\notes.html"])).toBe(
      "C:\\Users\\ashton\\notes.html"
    );
  });

  it("never reads a switch as a path", () => {
    // Electron and Chromium both pass switches that can end in anything.
    expect(localDocumentArgument(["exe", "--trace-file=/tmp/x.html"])).toBeNull();
  });

  it("leaves anything carrying a scheme to urlFromCommandLine", () => {
    expect(localDocumentArgument(["exe", "https://example.com/page.html"])).toBeNull();
    expect(localDocumentArgument(["exe", "file:///C:/tmp/page.html"])).toBeNull();
  });

  it("ignores a path that is not a document type", () => {
    expect(localDocumentArgument(["exe", "C:\\Users\\ashton\\secrets.txt"])).toBeNull();
  });
});

describe("displayHostname", () => {
  it("labels the neutral page as a new tab", () => {
    expect(displayHostname(BLANK_PAGE)).toBe("New tab");
  });

  it("strips the www prefix", () => {
    expect(displayHostname("https://www.example.com/a/b")).toBe("example.com");
  });

  it("falls back for unparseable input", () => {
    expect(displayHostname("nonsense")).toBe("New tab");
  });
});

describe("searchTemplateForName", () => {
  it("resolves the engines it ships a template for", () => {
    expect(searchTemplateForName("DuckDuckGo")).toBe("https://duckduckgo.com/?q=%s");
    expect(searchTemplateForName("Google")).toBe("https://www.google.com/search?q=%s");
    expect(searchTemplateForName("Brave Search")).toBe("https://search.brave.com/search?q=%s");
    expect(searchTemplateForName("Startpage")).toBe(
      "https://www.startpage.com/sp/search?query=%s"
    );
  });

  it("ignores case, spacing, and punctuation in the imported name", () => {
    for (const name of ["duckduckgo", "Duck Duck Go", "DuckDuckGo!", "  DUCKDUCKGO  "]) {
      expect(searchTemplateForName(name), name).toBe("https://duckduckgo.com/?q=%s");
    }
  });

  it("still resolves a name carrying a suffix", () => {
    // Chromium profiles often store "Google (Default)" or similar.
    expect(searchTemplateForName("Google (Default)")).toBe(
      "https://www.google.com/search?q=%s"
    );
  });

  it("is null for an engine it has no template for", () => {
    // Guessing a pattern from the name would be the "copy the template"
    // behaviour migration exists to refuse.
    for (const name of ["Some Intranet Search", "", null, undefined, "!!!", "   "]) {
      expect(searchTemplateForName(name)).toBeNull();
    }
  });

  it("only ever returns a template this file ships", () => {
    // The security property: an imported string selects from these addresses,
    // it never becomes one.
    for (const name of [
      "Google",
      "https://evil.example/?q=%s",
      "javascript:alert(1)",
      "Bing"
    ]) {
      const template = searchTemplateForName(name);
      if (template === null) continue;
      expect(template.startsWith("https://")).toBe(true);
      expect(template).toContain("%s");
      expect(template).not.toContain("evil.example");
    }
  });
});

describe("resolveSearchTemplate", () => {
  it("falls back to the shipped default", () => {
    expect(resolveSearchTemplate(null)).toBe(DEFAULT_SEARCH_TEMPLATE);
    expect(resolveSearchTemplate("Some Intranet Search")).toBe(DEFAULT_SEARCH_TEMPLATE);
  });

  it("uses the imported engine when it is one we can reach", () => {
    expect(resolveSearchTemplate("DuckDuckGo")).toBe("https://duckduckgo.com/?q=%s");
  });

  it("produces a real search URL when combined with a query", () => {
    const url = buildSearchUrl("rust traits", resolveSearchTemplate("DuckDuckGo"));
    expect(url).toBe("https://duckduckgo.com/?q=rust%20traits");
  });

  it("still escapes a query that would otherwise alter the URL", () => {
    const url = buildSearchUrl("a&b=c#d", resolveSearchTemplate("DuckDuckGo"));
    expect(url).not.toContain("&b=");
    expect(url).not.toContain("#d");
  });
});
