import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors, HttpInterceptorFn } from '@angular/common/http';
import { routes } from './app.routes';
import { provideClientHydration } from '@angular/platform-browser';
import { LucideAngularModule, GripHorizontal, Columns2, SquareMenu, PlaySquare, Cast, Maximize, Volume2, VolumeX, Menu, Search, X, Heart, Settings, ShieldAlert, MonitorPlay, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Info, AlertTriangle, ArrowUp, ArrowDown, Clock, HelpCircle, Film, Newspaper, Trophy, Music, Monitor, Radio, Baby, Globe, HeartPulse, List, FolderTree, ArrowRight, LayoutDashboard, LogOut, Play, Disc, Video, CalendarDays, Eye, EyeOff, Palette, Activity, Server } from 'lucide-angular';

const serverUrlInterceptor: HttpInterceptorFn = (req, next) => {
  if (typeof window !== 'undefined') {
    const serverUrl = localStorage.getItem('iptv_server_url');
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
    provideHttpClient(withInterceptors([serverUrlInterceptor])), 
    provideClientHydration(),
    importProvidersFrom(LucideAngularModule.pick({
        GripHorizontal, Columns2, SquareMenu, PlaySquare, Cast, Maximize, Volume2, VolumeX, Menu, Search, X, Heart, Settings, ShieldAlert, MonitorPlay, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Info, AlertTriangle, ArrowUp, ArrowDown, Clock, HelpCircle, Film, Newspaper, Trophy, Music, Monitor, Radio, Baby, Globe, HeartPulse, List, FolderTree, ArrowRight, LayoutDashboard, LogOut, Play, Disc, Video, CalendarDays, Eye, EyeOff, Palette, Activity, Server
    }))
  ]
};
