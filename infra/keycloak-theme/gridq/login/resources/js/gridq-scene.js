// Injects the same animated grid scene used on the app's landing page
// (Splash.jsx) as real DOM content, since a CSS background-image can't run
// the same live animations. Runs on every login-flow page (login, OTP,
// forgot-password, etc.) via theme.properties' `scripts=`.
(function () {
  function inject() {
    if (document.getElementById('gridq-scene')) return; // don't double-inject on partial reloads

    var wrap = document.createElement('div');
    wrap.id = 'gridq-scene';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML =
      '<div class="gridq-grid"></div>' +
      '<svg class="gridq-towers" viewBox="0 0 900 260" preserveAspectRatio="xMidYMax slice">' +
        '<defs><filter id="gridqGlow" x="-200%" y="-200%" width="500%" height="500%">' +
          '<feGaussianBlur stdDeviation="3" result="b"/>' +
          '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
        '</filter></defs>' +
        '<path id="gridqWireA" d="M90,95 Q270,145 450,100" fill="none" stroke="#2e4562" stroke-width="2"/>' +
        '<path id="gridqWireB" d="M450,100 Q630,150 810,95" fill="none" stroke="#2e4562" stroke-width="2"/>' +
        '<path id="gridqWireA2" d="M90,110 Q270,158 450,115" fill="none" stroke="#2e4562" stroke-width="2"/>' +
        '<path id="gridqWireB2" d="M450,115 Q630,163 810,110" fill="none" stroke="#2e4562" stroke-width="2"/>' +
        '<g fill="none" stroke="#41597a" stroke-width="3" stroke-linejoin="round">' +
          '<path d="M90,95 L60,255 M90,95 L120,255 M70,160 L110,160 M75,200 L105,200 M40,95 L140,95 M55,80 L125,80"/>' +
          '<path d="M450,60 L410,255 M450,60 L490,255 M420,140 L480,140 M425,190 L475,190 M400,60 L500,60 M415,42 L485,42"/>' +
          '<path d="M810,95 L780,255 M810,95 L840,255 M790,160 L830,160 M795,200 L825,200 M760,95 L860,95 M775,80 L845,80"/>' +
        '</g>' +
        '<path d="M96,255 L124,178" stroke="#41597a" stroke-width="2" stroke-dasharray="1 6" stroke-linecap="round"/>' +
        // lineman — working arm
        '<g transform="translate(433,140) scale(0.42)">' +
          '<path d="M-5,-8 Q0,-15 5,-8 L5,-5 L-5,-5 Z" fill="#050a12"/>' +
          '<circle cx="0" cy="-2" r="5.5" fill="#050a12"/>' +
          '<path d="M0,4 L-2,28" stroke="#050a12" stroke-width="5" stroke-linecap="round"/>' +
          '<path d="M-2,28 L-13,50 M-2,28 L9,49" stroke="#050a12" stroke-width="5" stroke-linecap="round"/>' +
          '<path d="M0,10 L-14,2" stroke="#050a12" stroke-width="5" stroke-linecap="round"/>' +
          '<g class="gridq-arm" style="transform-origin:0px 10px">' +
            '<path d="M0,10 L17,15 L21,4" stroke="#050a12" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
          '</g>' +
        '</g>' +
        // climber — stepping legs
        '<g transform="translate(112,214) scale(0.4)">' +
          '<path d="M-5,-8 Q0,-15 5,-8 L5,-5 L-5,-5 Z" fill="#050a12"/>' +
          '<circle cx="0" cy="-2" r="5.5" fill="#050a12"/>' +
          '<path d="M0,4 L0,25" stroke="#050a12" stroke-width="5" stroke-linecap="round"/>' +
          '<path d="M0,10 L-13,17 M0,10 L14,7" stroke="#050a12" stroke-width="5" stroke-linecap="round"/>' +
          '<g class="gridq-leg-a" style="transform-origin:0px 25px"><path d="M0,25 L-11,36" stroke="#050a12" stroke-width="5" stroke-linecap="round" fill="none"/></g>' +
          '<g class="gridq-leg-b" style="transform-origin:0px 25px"><path d="M0,25 L10,36" stroke="#050a12" stroke-width="5" stroke-linecap="round" fill="none"/></g>' +
        '</g>' +
        '<g transform="translate(755,208)" fill="none" stroke="#41597a" stroke-width="2.4" stroke-linejoin="round">' +
          '<path d="M0,32 L0,12 L34,12 L44,24 L44,32 Z"/><line x1="20" y1="12" x2="20" y2="32"/>' +
          '<circle cx="10" cy="32" r="5" fill="#0f1b2d"/><circle cx="36" cy="32" r="5" fill="#0f1b2d"/>' +
        '</g>' +
        buildPulses() +
      '</svg>';

    document.body.insertBefore(wrap, document.body.firstChild);
  }

  function buildPulses() {
    var wires = [
      ['#gridqWireA', '2.6s', '0s'], ['#gridqWireA', '2.6s', '1.3s'],
      ['#gridqWireB', '2.6s', '0.4s'], ['#gridqWireB', '2.6s', '1.7s'],
      ['#gridqWireA2', '3.1s', '0.8s'], ['#gridqWireB2', '3.1s', '2.1s'],
    ];
    var out = '';
    for (var i = 0; i < wires.length; i++) {
      out += '<circle r="3" fill="#3ee6c8" filter="url(#gridqGlow)">' +
        '<animateMotion dur="' + wires[i][1] + '" begin="' + wires[i][2] + '" repeatCount="indefinite">' +
          '<mpath href="' + wires[i][0] + '"></mpath>' +
        '</animateMotion></circle>';
    }
    return out;
  }

  if (document.body) inject();
  else document.addEventListener('DOMContentLoaded', inject);
})();