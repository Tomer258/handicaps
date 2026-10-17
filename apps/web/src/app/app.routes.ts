import { Routes } from '@angular/router';
import { anonymousGuard, authGuard } from './core/auth/guards';

export const routes: Routes = [
  { path: 'login', canActivate: [anonymousGuard], loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage), title: 'Sign in · Hangar' },
  { path: 'invite/:secret', loadComponent: () => import('./features/auth/invite.page').then((m) => m.InvitePage), title: 'Invitation · Hangar' },
  { path: 'offline', loadComponent: () => import('./features/auth/offline.page').then((m) => m.OfflinePage), title: 'Offline · Hangar' },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./features/shell/app-shell').then((m) => m.AppShell),
    children: [
      { path: '', loadComponent: () => import('./features/shell/home.page').then((m) => m.HomePage), title: 'Hangar' },
      {
        path: 's/:serverId',
        loadComponent: () => import('./features/shell/server-view').then((m) => m.ServerView),
        children: [
          { path: 'c/:channelId', loadComponent: () => import('./features/messages/text-channel.page').then((m) => m.TextChannelPage) },
          { path: 'v/:channelId', loadComponent: () => import('./features/voice/voice-room.page').then((m) => m.VoiceRoomPage) },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
