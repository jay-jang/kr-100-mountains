import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nearbyRoutes, nearbyMountains} from '../src/mapselection.js';
const view={project:([x,y])=>({x,y})};
test('wide screen hit area returns every overlapping route in distance order',()=>{
  const a={rid:1,latlngs:[[0,0],[100,0]]},b={rid:2,latlngs:[[0,8],[100,8]]},far={rid:3,latlngs:[[0,50],[100,50]]};
  assert.deepEqual(nearbyRoutes(view,[a,b,far],[50,10]).map(r=>r.rid),[2,1]);
});
test('GPX segment gaps are not selectable as synthetic paths',()=>{
  const r={track:{segments:[[{lat:0,lon:0},{lat:10,lon:0}],[{lat:90,lon:0},{lat:100,lon:0}]]}};
  assert.deepEqual(nearbyRoutes(view,[r],[50,0]),[]);
  assert.deepEqual(nearbyRoutes(view,[r],[5,10]),[r]);
});
test('hit area is measured in projected pixels rather than geographical degrees',()=>{
  const r={latlngs:[[0,0],[1,0]]},zoomed={project:([x,y])=>({x:x*100,y:y*100})};
  assert.deepEqual(nearbyRoutes(zoomed,[r],[.5,.1]),[r]);
  assert.deepEqual(nearbyRoutes(zoomed,[r],[.5,.2]),[]);
});
test('overlapping mountain picker excludes distant and missing coordinates',()=>{
  const a={name_full:'A',lat:0,lon:0},b={name_full:'B',lat:20,lon:20},far={name_full:'C',lat:100,lon:0},missing={name_full:'D',lat:null};
  assert.deepEqual(nearbyMountains(view,[far,b,a,missing],a),[a,b]);
});
test('upper marker areas include vertically overlapping targets and rectangle corners',()=>{
  const a={name_full:'A',lat:0,lon:0},b={name_full:'B',lat:0,lon:60},c={name_full:'C',lat:43,lon:70};
  const far={name_full:'D',lat:0,lon:73},side={name_full:'E',lat:45,lon:0};
  assert.deepEqual(nearbyMountains(view,[a,b,c,far,side],a),[a,b,c]);
});
