// ==UserScript==
// @name         AcFunReveal - A站网页版显示 IP 属地
// @namespace    http://acfun-reveal.local
// @version      5.8.0
// @description  显示评论 IP 属地（可视区域优先），并将设备型号代号替换为友好名称
// @author       name_xxl
// @match        https://www.acfun.cn/*
// @match        https://m.acfun.cn/*
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';
