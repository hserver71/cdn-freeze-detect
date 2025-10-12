import logo from './logo.svg';
import './App.css';
import SmartTable from './SmartTable';

const sampleData = [
  { name: "Alice", age: 25, country: "USA" },
  { name: "Bob", age: 30, country: "UK" },
  { name: "Charlie", age: 28, country: "Canada" },
  { name: "David", age: 35, country: "Australia" },
  { name: "Eve", age: 22, country: "Germany" },
  { name: "Frank", age: 33, country: "France" },
];

function App() {
  return (
    <div>
      <h2 style={{ textAlign: "center" }}>Current Status</h2>
      <SmartTable data={sampleData} />
    </div>
  );
}

export default App;
