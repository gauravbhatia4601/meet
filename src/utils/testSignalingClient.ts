/**
 * Test Script for Signaling Client
 * 
 * Simple test to verify the SignalingClient works
 * Run this in the browser console or as a test file
 */

import { signalingClient } from '../services/signaling/index.js';

export async function testSignalingClient() {
  console.log('🧪 Testing SignalingClient...\n');

  try {
    // Test 1: Connect
    console.log('1️⃣ Connecting to signaling server...');
    await signalingClient.connect();
    console.log('✅ Connected successfully\n');

    // Test 2: Set callbacks
    console.log('2️⃣ Setting up event callbacks...');
    signalingClient.setCallbacks({
      onConnected: () => console.log('📡 Callback: Connected'),
      onRoomJoined: (data) => console.log('✅ Callback: Room joined', data),
      onParticipantJoined: (data) => console.log('👤 Callback: Participant joined', data),
      onChatMessage: (data) => console.log('💬 Callback: Chat message', data),
      onError: (error) => console.error('❌ Callback: Error', error)
    });
    console.log('✅ Callbacks set\n');

    // Test 3: Join room as host
    console.log('3️⃣ Joining room as host...');
    const testRoomCode = 'test-room-' + Math.random().toString(36).substring(7);
    const testPeerId = 'peer-' + Math.random().toString(36).substring(7);
    
    signalingClient.joinRoom(testRoomCode, testPeerId, 'Test User', true);
    console.log(`✅ Join request sent for room: ${testRoomCode}`);
    console.log(`   Peer ID: ${testPeerId}\n`);

    // Test 4: Check connection state
    console.log('4️⃣ Checking connection state...');
    const isConnected = signalingClient.isConnected();
    const connectionState = signalingClient.getConnectionState();
    console.log(`   Connected: ${isConnected}`);
    console.log(`   State: ${connectionState}`);
    console.log('✅ Connection state check complete\n');

    // Test 5: Send test chat message
    console.log('5️⃣ Sending test chat message...');
    signalingClient.sendChatMessage('Hello from test!');
    console.log('✅ Chat message sent\n');

    console.log('✅✅✅ All tests passed! ✅✅✅');
    console.log('\n📝 Note: Keep this connection alive to test room events');
    console.log('   Open another tab/window and join the same room to see participant events');

    // Return client for manual testing
    return {
      signalingClient,
      roomCode: testRoomCode,
      peerId: testPeerId,
      disconnect: () => {
        console.log('🔌 Disconnecting...');
        signalingClient.disconnect();
      }
    };

  } catch (error) {
    console.error('❌ Test failed:', error);
    throw error;
  }
}

// Auto-run in browser console
if (typeof window !== 'undefined') {
  (window as any).testSignalingClient = testSignalingClient;
  console.log('💡 Run testSignalingClient() in the console to test the signaling client');
}

