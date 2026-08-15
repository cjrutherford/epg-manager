import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors, HttpInterceptorFn } from '@angular/common/http';
import { routes } from './app.routes';
import { authInterceptor } from './services/auth.interceptor';
import { provideClientHydration } from '@angular/platform-browser';
import { LucideAngularModule, GripHorizontal, Columns2, SquareMenu, PlaySquare, Cast, Maximize, Minimize, PictureInPicture2, PictureInPicture, Volume2, VolumeX, Menu, Search, X, Heart, Settings, ShieldAlert, MonitorPlay, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Info, AlertTriangle, ArrowUp, ArrowDown, Clock, HelpCircle, Film, Newspaper, Trophy, Music, Monitor, Radio, Baby, Globe, HeartPulse, List, FolderTree, ArrowRight, LayoutDashboard, LogOut, Play, Disc, Video, CalendarDays, Eye, EyeOff, Palette, Activity, Server, RefreshCw, Rocket, Package, Satellite, Siren, StopCircle, Link2, Clapperboard, Zap, HardDrive, FileVideo, Check, Plus, Trash2, CircleAlert } from 'lucide-angular';

const serverUrlInterceptor: HttpInterceptorFn = (req, next) => {
  if (typeof window !== 'undefined') {
    let serverUrl = localStorage.getItem('tuner_daemon_server_url');
    if (!serverUrl) {
      const origin = window.location.origin || '';
      if (origin.startsWith('capacitor:') || 
          origin === 'http://localhost' || 
          origin === 'https://localhost' || 
          origin.startsWith('file:')) {
        serverUrl = 'https://teevee.christopherrutherford.net';
      } else if (origin.includes(':4200')) {
        serverUrl = 'http://localhost:3000';
      } else {
        serverUrl = origin;
      }
    }
    if (serverUrl && req.url.startsWith('/api/')) {
      const base = serverUrl.replace(/\/+$/, '');
      const clone = req.clone({
        url: `${base}${req.url}`
      });
      return next(clone);
    }
  }
  return next(req);
};

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    // authInterceptor runs first so it sees relative /api/ urls before the
    // serverUrl rewrite turns them absolute.
    provideHttpClient(withInterceptors([authInterceptor, serverUrlInterceptor])),
    provideClientHydration(),
    importProvidersFrom(LucideAngularModule.pick({
        GripHorizontal, Columns2, SquareMenu, PlaySquare, Cast, Maximize, Minimize, PictureInPicture2, PictureInPicture, Volume2, VolumeX, Menu, Search, X, Heart, Settings, ShieldAlert, MonitorPlay, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Info, AlertTriangle, ArrowUp, ArrowDown, Clock, HelpCircle, Film, Newspaper, Trophy, Music, Monitor, Radio, Baby, Globe, HeartPulse, List, FolderTree, ArrowRight, LayoutDashboard, LogOut, Play, Disc, Video, CalendarDays, Eye, EyeOff, Palette, Activity, Server,
        RefreshCw, Rocket, Package, Satellite, Siren, StopCircle, Link2, Clapperboard, Zap, HardDrive, FileVideo, Check, Plus, Trash2, CircleAlert
    }))
  ]
};
