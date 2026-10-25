(function(){var k='rp-theme',d=document.documentElement;
function saved(){try{return localStorage.getItem(k)}catch(e){return null}}
function set(t){d.setAttribute('data-theme',t)}
set(saved()||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'));
document.addEventListener('DOMContentLoaded',function(){var bar=document.querySelector('.bar');if(!bar)return;
 var b=document.createElement('button');b.type='button';b.className='btn ghost sm';
 function paint(){var dark=d.getAttribute('data-theme')==='dark';b.textContent=dark?'Light mode':'Dark mode';b.setAttribute('aria-label','Switch to '+(dark?'light':'dark')+' mode')}
 b.onclick=function(){var t=d.getAttribute('data-theme')==='dark'?'light':'dark';set(t);try{localStorage.setItem(k,t)}catch(e){}paint()};
 paint();bar.appendChild(b)})})();
