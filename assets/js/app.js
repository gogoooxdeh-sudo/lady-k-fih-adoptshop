/* Shared public-site shell and non-transactional interactions. */
const navItems = [
  ['Home', 'index.html', 'home'],
  ['Available Adopts', 'available-adopts.html', 'available'],
  ['Custom Adopts', 'custom-adopts.html', 'custom'],
  ['Sold Archive', 'sold-archive.html', 'archive'],
  ['Information', 'information.html', 'information'],
  ['Contact', 'contact.html', 'contact']
];
const page = document.body.dataset.page || 'home';
const nav = navItems.map(([label, href, key]) => `<a href="${href}"${page === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');

document.querySelector('#site-header').innerHTML = `
<header class="site-header"><div class="header-inner">
  <a class="brand" href="index.html" aria-label="Lady K Star Fih AdoptShop home"><span class="brand-star">✦</span><span class="brand-name">Lady K <span>★</span> Fih<small>ADOPTSHOP</small></span></a>
  <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="main-nav"><span class="menu-lines" aria-hidden="true">☰</span><span class="sr-only">Open navigation</span></button>
  <nav class="main-nav" id="main-nav" aria-label="Main navigation">${nav}</nav>
</div></header>`;

document.querySelector('#site-footer').innerHTML = `
<footer class="site-footer"><div class="footer-inner"><div class="footer-top"><div class="footer-brand"><a class="brand" href="index.html"><span class="brand-star">✦</span><span class="brand-name">Lady K <span>★</span> Fih<small>ADOPTSHOP</small></span></a><p>A little boutique for character designs and new stories.</p></div><div class="footer-links"><div><h2>Explore</h2><a href="available-adopts.html">Available Adopts</a><a href="custom-adopts.html">Custom Adopts</a><a href="sold-archive.html">Sold Archive</a></div><div><h2>More</h2><a href="information.html">Information</a><a href="information.html#terms">Official Terms of Service</a><a href="contact.html">Contact</a></div></div></div><div class="footer-bottom"><span>© <span id="copyright-year"></span> Lady K ★ Fih. All rights reserved.</span><span class="footer-note">Made with care <span aria-hidden="true">✧</span></span></div><button class="admin-star" type="button" aria-label="Administrator access" title="Administrator access">✦</button></div></footer>
<div class="modal-backdrop" id="admin-modal" hidden><section class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-title"><button class="modal-close" type="button" aria-label="Close administrator access">×</button><span class="modal-star" aria-hidden="true">✧</span><p class="eyebrow">Private area</p><h2 id="admin-title">Administrator Access</h2><p class="modal-intro">Sign-in will be available after secure authentication is implemented.</p><form class="admin-form"><label for="admin-password">Password</label><input id="admin-password" name="password" type="password" autocomplete="current-password" placeholder="Enter password"><button class="button primary full-width" type="submit">Log In</button><p class="auth-note" aria-live="polite"></p></form></section></div>`;

document.querySelectorAll('.card-grid').forEach(grid => {
  const count = 8;
  const archive = page === 'archive';
  const categories = ['Human', 'Furry / Anthro', 'Feral', 'Other'];
  grid.innerHTML = Array.from({length: count}, (_, i) => `
    <article class="adopt-card ${archive ? 'archived-card' : ''}" data-category="${categories[i % categories.length]}" data-sample-index="${i + 1}">
      <div class="card-art art-placeholder"><span>✧</span><span class="placeholder-caption">ARTWORK<br>PLACEHOLDER</span><span>✦</span><span class="sample-label">SAMPLE LAYOUT · NOT REAL INVENTORY</span></div>
      <div class="card-body"><div class="card-overline"><span>${archive ? 'ARCHIVE TEMPLATE' : 'LISTING TEMPLATE'}</span><span>${archive ? 'ARCHIVED' : 'PLACEHOLDER'}</span></div><h3>${archive ? 'Archived Character' : 'Character Name'}</h3><p class="card-meta">Adopt ID · —</p><p class="card-category">Category · ${categories[i % categories.length]} (sample)</p>${archive ? '' : '<p class="card-price">Price · to be added</p>'}</div>
      ${archive ? '' : '<a class="card-link" href="adopt-details.html">View detail layout <span aria-hidden="true">→</span></a>'}
    </article>`).join('');
});

document.querySelector('#copyright-year').textContent = new Date().getFullYear();
const menuButton = document.querySelector('.menu-toggle');
const mainNav = document.querySelector('.main-nav');
menuButton.addEventListener('click', () => {
  const expanded = menuButton.getAttribute('aria-expanded') === 'true';
  menuButton.setAttribute('aria-expanded', String(!expanded));
  mainNav.classList.toggle('is-open', !expanded);
});
mainNav.addEventListener('click', event => {
  if (event.target.closest('a')) {
    mainNav.classList.remove('is-open');
    menuButton.setAttribute('aria-expanded', 'false');
  }
});
const modal = document.querySelector('#admin-modal');
const password = document.querySelector('#admin-password');
const openButton = document.querySelector('.admin-star');
const closeButton = document.querySelector('.modal-close');
function closeModal() { modal.hidden = true; openButton.focus(); }
openButton.addEventListener('click', () => { modal.hidden = false; password.value = ''; document.querySelector('.auth-note').textContent = ''; closeButton.focus(); });
closeButton.addEventListener('click', closeModal);
modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) closeModal(); });
document.querySelector('.admin-form').addEventListener('submit', event => {
  event.preventDefault();
  document.querySelector('.auth-note').textContent = 'Authentication is not available in this preview.';
  password.value = '';
});
