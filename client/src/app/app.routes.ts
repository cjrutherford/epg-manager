import { Routes } from '@angular/router';

export const routes: Routes = [
    { path: '', redirectTo: 'watch', pathMatch: 'full' },
    {
        path: 'watch',
        loadComponent: () => import('./watch/watch.component').then(m => m.WatchComponent)
    },
    {
        path: 'admin',
        loadComponent: () => import('./admin/admin-layout.component').then(m => m.AdminLayoutComponent),
        children: [
            { path: '', redirectTo: 'dashboard', pathMatch: 'full' },
            { path: 'dashboard', loadComponent: () => import('./admin/dashboard/dashboard.component').then(m => m.DashboardComponent) },
            { path: 'channels', loadComponent: () => import('./admin/channels/channel-manager.component').then(m => m.ChannelManagerComponent) },
            { path: 'dvr', loadComponent: () => import('./admin/dvr/dvr.component').then(m => m.DvrComponent) },
            { path: 'settings', loadComponent: () => import('./admin/settings/settings.component').then(m => m.SettingsComponent) },
        ]
    },
    { path: '**', redirectTo: 'watch' }
];
