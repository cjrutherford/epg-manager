import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface VersionInfo {
  version: string | null;
  commit: string | null;
  buildTime: string | null;
}

export interface UpdateCheck {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  pullCommand: string | null;
  error?: string;
  inContainerUpgradeEnabled?: boolean;
}

@Injectable({ providedIn: 'root' })
export class UpdateService {
  constructor(private http: HttpClient) {}

  getVersion(): Observable<VersionInfo> {
    return this.http.get<VersionInfo>('/api/version');
  }

  checkUpdate(): Observable<UpdateCheck> {
    return this.http.get<UpdateCheck>('/api/update/check');
  }

  applyUpdate(tag: string): Observable<any> {
    return this.http.post('/api/update/apply', { tag });
  }
}
