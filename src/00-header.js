// ==UserScript==
// @name         AcFunReveal - A站网页版显示 IP 属地
// @namespace    http://acfun-reveal.local
// @version      5.6.1
// @description  可视区域优先：只查询可见评论的 IP，滚动时自动加载
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
