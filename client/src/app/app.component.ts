import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastContainerComponent } from './services/toast-container.component';
import { ConfirmDialogComponent } from './services/confirm-dialog.component';
import { ThemeService } from './services/theme.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastContainerComponent, ConfirmDialogComponent],
  // Both mounted at the root rather than per-layout. The toast container used
  // to live only in the admin layout, so the Watch UI's thirteen toast calls
  // rendered nowhere at all — every message it produced was invisible.
  template: `
    <router-outlet></router-outlet>
    <app-toast-container></app-toast-container>
    <app-confirm-dialog></app-confirm-dialog>
  `
})
export class AppComponent {
  // Constructing the theme service at the root applies the saved theme before
  // any lazy shell (and therefore any theme menu) exists. Without this the
  // preference only came back after opening the picker once.
  constructor(themeService: ThemeService) {
    void themeService;
  }
}
