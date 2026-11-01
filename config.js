// Paste the "App key" from https://www.dropbox.com/developers/apps here.
// It is safe to publish: sign-in uses PKCE, so there is no app secret.
const DROPBOX_APP_KEY = "rzgkk7byuhbp06y";

// Must exactly match a Redirect URI in the Dropbox app settings.
const REDIRECT_URI = `${location.origin}${location.pathname.replace(/index\.html$/, "")}`;
