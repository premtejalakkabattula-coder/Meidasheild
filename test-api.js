// Simple test to verify API endpoints

// Test Register
async function testRegister() {
  const response = await fetch('http://localhost:3000/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
  });
  console.log('Register Status:', response.status);
  const text = await response.text();
  console.log('Register Response:', text);
}

// Test Login
async function testLogin() {
  const response = await fetch('http://localhost:3000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'password123' })
  });
  console.log('Login Status:', response.status);
  const text = await response.text();
  console.log('Login Response:', text);
}

// Run tests
testRegister().then(() => testLogin()).catch(console.error);