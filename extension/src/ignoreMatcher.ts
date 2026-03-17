export class IgnoreMatcher {
  private patterns: RegExp[] = [];
  private rawPatterns: string[] = [];

  constructor(rawPatterns: string[]) {
    this.rawPatterns = rawPatterns;
    this.patterns = rawPatterns.map(p => this.compilePattern(p));
  }

  private compilePattern(p: string): RegExp {
    // Strip trailing slash for easier segment matching
    const noTrailingSlash = p.endsWith('/') ? p.slice(0, -1) : p;
    
    // Replace * with segment-bound matcher [^/]*
    const regexStr = noTrailingSlash
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // escape regex chars
      .replace(/\*/g, '[^/]*'); 
      
    // Exact segment match logic
    const prefix = regexStr.startsWith('/') ? '^' : '(^|/)';
    const suffix = '($|/)';
    
    return new RegExp(prefix + regexStr + suffix);
  }

  public isIgnored(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, '/');
    return this.patterns.some(p => p.test(normalized));
  }

  public explain(relativePath: string): string | null {
    const normalized = relativePath.replace(/\\/g, '/');
    for (let i = 0; i < this.patterns.length; i++) {
      if (this.patterns[i].test(normalized)) return this.rawPatterns[i] ?? '(unknown)';
    }
    return null;
  }
}
